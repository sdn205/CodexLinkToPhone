param([string]$RepositoryRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$legacy = Join-Path $root '.state'
if (-not (Test-Path -LiteralPath $legacy -PathType Container)) {
    Write-Host 'No legacy state directory to migrate.'
    return
}
$bridgeExe = Join-Path $root 'server/dist/codex-phone-bridge.exe'
$running = @(Get-CimInstance Win32_Process -Filter "Name='codex-phone-bridge.exe'" |
    Where-Object { $_.ExecutablePath -eq $bridgeExe })
if ($running.Count) { throw 'Stop the phone bridge before migrating its state.' }

$data = Join-Path $root 'server/data'
$manager = Join-Path $root 'assistant/data'
$backups = Join-Path $root 'assistant/backups'
$registry = Join-Path $root 'proxy/runtime/instances'
$serverLogs = Join-Path $root 'server/logs'
$proxyLogs = Join-Path $root 'proxy/logs'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$archive = Join-Path $backups ('state-migration-' + $stamp)

function Assert-LocalPath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not $absolute.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Migration path is outside the repository: $absolute"
    }
    return $absolute
}
function Read-Legacy([string]$Name) {
    $path = Join-Path $legacy $Name
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        return Get-Content -LiteralPath $path -Raw -Encoding utf8 | ConvertFrom-Json
    }
    return $null
}
function Write-NewJson([string]$Path, $Value) {
    if (Test-Path -LiteralPath $Path) { throw "Target already exists: $Path" }
    $temp = $Path + '.tmp'
    $text = ConvertTo-Json -InputObject $Value -Depth 100 -Compress
    [IO.File]::WriteAllText($temp, $text + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $Path
}
function Move-Local([string]$Source, [string]$Target) {
    $sourcePath = Assert-LocalPath $Source
    $targetPath = Assert-LocalPath $Target
    if ((Get-Item -LiteralPath $sourcePath).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Migration source is already a link: $sourcePath"
    }
    if (Test-Path -LiteralPath $targetPath) { throw "Target already exists: $targetPath" }
    New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
    Move-Item -LiteralPath $sourcePath -Destination $targetPath
}
$selection = Read-Legacy 'phone-selection.json'
$unread = Read-Legacy 'unread-threads.json'
$mode = Read-Legacy 'phone-proxy-mode.json'
$recent = Read-Legacy 'phone-manager-recent.json'
$pause = Read-Legacy 'phone-bridge-pause.json'
$operations = Join-Path $legacy 'phone-operations.json'
$legacyNames = @('phone-operations.json','phone-selection.json','unread-threads.json',
    'phone-proxy-mode.json','phone-manager-recent.json','phone-bridge-pause.json','token.json','relay-agent.json')
$remaining = @($legacyNames | Where-Object { Test-Path -LiteralPath (Join-Path $legacy $_) -PathType Leaf })
$legacyDirectories = @(Get-ChildItem -LiteralPath $legacy -Directory -Force | Where-Object {
    $_.Name -in @('uploads','trae-proxy.json.instances') -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
})
if (-not $remaining.Count -and -not $legacyDirectories.Count) {
    Write-Host 'No legacy state files remain. Existing path links are retained for old image references or running proxies.'
    return
}
foreach ($target in @((Join-Path $data 'state.json'), (Join-Path $data 'state.json.tmp'), (Join-Path $data 'operations.json'),
    (Join-Path $data 'uploads'), (Join-Path $manager 'state.json'), $registry, $archive,
    (Join-Path $manager 'state.json.tmp'), (Join-Path $proxyLogs 'proxy.log'))) {
    [void](Assert-LocalPath $target)
    if (Test-Path -LiteralPath $target) { throw "Target already exists; migration has not started: $target" }
}
# Check all move sources and destinations before changing any file.
$directories = @('uploads', 'trae-proxy.json.instances')
foreach ($name in $directories) {
    $path = Join-Path $legacy $name
    if (Test-Path -LiteralPath $path) {
        $items = @((Get-Item -LiteralPath $path)) + @(Get-ChildItem -LiteralPath $path -Recurse -Force)
        if (@($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
            throw "Legacy directory contains a link: $path"
        }
    }
}
$legacyBackups = @(Get-ChildItem -LiteralPath $legacy -File -Filter 'trae-settings-before-phone-mode-*.json')
foreach ($file in $legacyBackups) {
    if (Test-Path -LiteralPath (Join-Path $backups $file.Name)) { throw "Backup destination already exists: $($file.Name)" }
}
$logs = @(Get-ChildItem -LiteralPath $legacy -File -Filter 'phone-bridge-*.log')
foreach ($file in $logs) {
    if (Test-Path -LiteralPath (Join-Path $serverLogs $file.Name)) { throw "Log destination already exists: $($file.Name)" }
}
$newBackup = ''
if ($mode -and $mode.backupPath) {
    $sourceBackup = Assert-LocalPath $mode.backupPath
    if (-not (Test-Path -LiteralPath $sourceBackup -PathType Leaf) -or
        (Split-Path -Parent $sourceBackup) -ne $legacy) { throw 'The referenced settings backup is missing or outside the legacy directory.' }
    $newBackup = Join-Path $backups (Split-Path -Leaf $sourceBackup)
}
foreach ($directory in @($data, $manager, $backups, $serverLogs, $proxyLogs, $archive)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
$state = [ordered]@{version=1; selection=$null; unreadThreads=@($unread | Where-Object { $_ -is [string] }); updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
if ($selection) { $state.selection = [ordered]@{threadId=$selection.threadId} }
Write-NewJson (Join-Path $data 'state.json') $state
$managerState = [ordered]@{version=1}
if ($mode) {
    $managerState.proxy = [ordered]@{
        settingsPath=$mode.settingsPath; backupPath=$newBackup
        previousCliExecutablePresent=[bool]$mode.previousCliExecutablePresent
        previousCliExecutable=[string]$mode.previousCliExecutable
        updatedAt=$mode.updatedAt
    }
}
if ($recent) { $managerState.recent = $recent }
if ($pause) { $managerState.pause = $pause }
Write-NewJson (Join-Path $manager 'state.json') $managerState
if (Test-Path -LiteralPath $operations) {
    # Copy verbatim: request checkpoints, plan ordering and the 500-item limit do not change.
    Copy-Item -LiteralPath $operations -Destination (Join-Path $data 'operations.json')
    if ((Get-FileHash -LiteralPath $operations).Hash -ne (Get-FileHash -LiteralPath (Join-Path $data 'operations.json')).Hash) {
        throw 'Operations copy failed its hash check.'
    }
}
foreach ($file in $legacyBackups) { Move-Local $file.FullName (Join-Path $backups $file.Name) }
foreach ($file in $logs) { Move-Local $file.FullName (Join-Path $serverLogs $file.Name) }
foreach ($mapping in @(@('uploads', (Join-Path $data 'uploads')), @('trae-proxy.json.instances', $registry))) {
    $source = Join-Path $legacy $mapping[0]
    if (Test-Path -LiteralPath $source) {
        Move-Local $source $mapping[1]
        # Preserve absolute image paths and registrations written by an already-running old proxy.
        New-Item -ItemType Junction -Path $source -Target $mapping[1] | Out-Null
    }
}
$oldLog = Join-Path $legacy 'codex-proxy-native.log'
if (Test-Path -LiteralPath $oldLog) {
    # An old proxy may keep appending until Trae reloads; both names refer to the same file.
    New-Item -ItemType HardLink -Path (Join-Path $proxyLogs 'proxy.log') -Target $oldLog | Out-Null
}
foreach ($name in $legacyNames) {
    $source = Join-Path $legacy $name
    if (Test-Path -LiteralPath $source) { Move-Local $source (Join-Path $archive $name) }
}
[pscustomobject]@{
    ServerData=$data; ManagerState=(Join-Path $manager 'state.json'); ProxyRegistry=$registry
    RecoveryArchive=$archive; LegacyAliases=$legacy
}
