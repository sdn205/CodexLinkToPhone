param([switch]$Managed, [switch]$Restart)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
if ($Managed -and $Restart) { throw 'Only Native AOT builds can be restarted' }
$dotnetExe = (Get-Command dotnet.exe -ErrorAction Stop).Source
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:NUGET_PACKAGES = Join-Path $projectRoot 'build/packages'
$env:TEMP = Join-Path $projectRoot 'build/temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
Push-Location $projectRoot
try {
    $sdkVersion = (& $dotnetExe --version).Trim()
    if ($sdkVersion -notmatch '^10\.0\.4\d\d$') { throw "System .NET SDK 10.0.4xx required; found $sdkVersion" }
    if ($Managed) {
        & $dotnetExe build CodexPhoneBridge.csproj -c Release -p:PublishAot=false
    } else {
        & $dotnetExe publish CodexPhoneBridge.csproj -c Release -r win-x64 -o (Join-Path $projectRoot 'build/publish')
    }
    if ($LASTEXITCODE -ne 0) { throw 'Phone bridge build failed' }
    if (-not $Managed) {
        $repoRoot = Split-Path -Parent $projectRoot
        if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'public/index.html'))) { throw 'Publish from the server directory' }
        $target = Join-Path $projectRoot 'dist/codex-phone-bridge.exe'
        $running = @(Get-CimInstance Win32_Process -Filter "Name='codex-phone-bridge.exe'" | Where-Object { $_.ExecutablePath -eq $target })
        if ($running.Count -gt 0 -and -not $Restart) { throw 'Bridge is running from dist. Build saved in build/publish; use -Restart to update and restart only the bridge.' }
        $manager = Join-Path $repoRoot 'assistant/dist/Codex手机助手.exe'
        function Invoke-Manager([string]$Action) {
            $start = New-Object System.Diagnostics.ProcessStartInfo
            $start.FileName = $manager
            $start.Arguments = "--action $Action"
            $start.WorkingDirectory = $repoRoot
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $start.RedirectStandardOutput = $true
            $start.RedirectStandardError = $true
            $process = [System.Diagnostics.Process]::Start($start)
            try {
                $outputTask = $process.StandardOutput.ReadToEndAsync()
                $errorTask = $process.StandardError.ReadToEndAsync()
                if (-not $process.WaitForExit(150000)) { throw "Phone manager $Action did not finish in time" }
                $result = $outputTask.GetAwaiter().GetResult()
                $errors = $errorTask.GetAwaiter().GetResult()
                if ($process.ExitCode -ne 0) { throw "$result$errors" }
                if ($Action -eq 'Status') { return ($result | ConvertFrom-Json) }
                Write-Host $result
            } finally {
                $process.Dispose()
            }
        }
        if ($Restart) {
            $status = (Invoke-Manager 'Status').status
            if (-not $status.proxyConfigured -or -not $status.traeOnline -or -not $status.proxyConnected) {
                throw 'Restart requires an active Trae proxy from dist. Reload Trae first; the current bridge has been kept running.'
            }
        }
        $previous = Join-Path $projectRoot 'build/previous/codex-phone-bridge.exe'
        New-Item -ItemType Directory -Force -Path (Split-Path $previous) | Out-Null
        New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
        $hadPrevious = Test-Path -LiteralPath $target
        if ($hadPrevious) { Copy-Item -LiteralPath $target -Destination $previous -Force }
        if ($Restart) { Invoke-Manager 'Stop' }
        try {
            Copy-Item -LiteralPath (Join-Path $projectRoot 'build/publish/codex-phone-bridge.exe') -Destination $target -Force
            if ($Restart) { Invoke-Manager 'Restart' }
        } catch {
            if ($hadPrevious) {
                if ($Restart) { Invoke-Manager 'Stop' }
                Copy-Item -LiteralPath $previous -Destination $target -Force
                if ($Restart) { Invoke-Manager 'Restart' }
            }
            throw
        }
        Write-Host "Phone bridge published: $target"
    }
} finally { Pop-Location }
