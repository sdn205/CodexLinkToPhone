param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [switch]$SkipTests,
    [switch]$SkipRootCopy
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$repositoryRoot = Split-Path -Parent $projectRoot
$buildDirectory = Join-Path $projectRoot 'build'
$distDirectory = Join-Path $projectRoot 'dist'
$outputName = 'Codex手机助手.exe'
$buildExecutable = Join-Path $buildDirectory 'CodexPhoneAssistant.exe'
$distExecutable = Join-Path $distDirectory $outputName
$rootExecutable = Join-Path $repositoryRoot $outputName

function Get-VsDevCmd {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        $installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($installation) {
            $candidate = Join-Path $installation 'Common7\Tools\VsDevCmd.bat'
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }

    $fallbacks = @(
        "$env:ProgramFiles\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"
    )
    foreach ($candidate in $fallbacks) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw '未找到带有 C++ x64 工具链的 Visual Studio。'
}

function Stop-LockedAssistant {
    param([string[]]$CandidatePaths)
    $normalized = @($CandidatePaths | ForEach-Object { [IO.Path]::GetFullPath($_).ToLowerInvariant() })
    foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
        $path = $null
        try {
            $path = $process.MainModule.FileName
            if ($path -and $normalized -contains ([IO.Path]::GetFullPath($path).ToLowerInvariant())) {
                Stop-Process -Id $process.Id -Force -ErrorAction Stop
                $process.WaitForExit(5000) | Out-Null
            }
        } catch {
            # 仅忽略无法读取的其他系统进程；目标路径匹配时 Stop-Process 的错误会继续抛出。
            if ($path -and $normalized -contains ([IO.Path]::GetFullPath($path).ToLowerInvariant())) { throw }
        }
    }
}

New-Item -ItemType Directory -Force -Path $buildDirectory, $distDirectory | Out-Null
Stop-LockedAssistant -CandidatePaths @($buildExecutable, $distExecutable, $rootExecutable)

$devCmd = Get-VsDevCmd
$configure = 'cmake -S "{0}" -B "{1}" -G "NMake Makefiles" -DCMAKE_BUILD_TYPE={2}' -f $projectRoot, $buildDirectory, $Configuration
$build = 'cmake --build "{0}" --config {1}' -f $buildDirectory, $Configuration
$command = 'call "{0}" -arch=x64 -host_arch=x64 && {1} && {2}' -f $devCmd, $configure, $build
& cmd.exe /d /s /c $command
if ($LASTEXITCODE -ne 0) {
    throw "构建失败，退出代码：$LASTEXITCODE"
}

if (-not $SkipTests) {
    & ctest --test-dir $buildDirectory --output-on-failure -C $Configuration
    if ($LASTEXITCODE -ne 0) { throw "测试失败，退出代码：$LASTEXITCODE" }
}

if (-not (Test-Path -LiteralPath $buildExecutable)) {
    throw "未找到构建产物：$buildExecutable"
}
Copy-Item -LiteralPath $buildExecutable -Destination $distExecutable -Force
if (-not $SkipRootCopy) {
    Copy-Item -LiteralPath $distExecutable -Destination $rootExecutable -Force
}

$hash = (Get-FileHash -LiteralPath $distExecutable -Algorithm SHA256).Hash
$item = Get-Item -LiteralPath $distExecutable
[pscustomobject]@{
    Path = $item.FullName
    Size = $item.Length
    SHA256 = $hash
    RootCopy = if ($SkipRootCopy) { $null } else { $rootExecutable }
}
