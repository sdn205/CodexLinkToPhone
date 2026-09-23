param([switch]$Managed, [string]$OutputPath = '')
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$dotnetExe = (Get-Command dotnet.exe -ErrorAction Stop).Source
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:DOTNET_NOLOGO = '1'
$env:NUGET_PACKAGES = Join-Path $projectRoot 'build/packages'
$env:TEMP = Join-Path $projectRoot 'build/temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
Push-Location $projectRoot
try {
    $sdkVersion = (& $dotnetExe --version).Trim()
    if ($sdkVersion -notmatch '^10\.0\.4\d\d$') {
        throw "系统 .NET SDK 版本不符合项目要求：$sdkVersion（需要 10.0.4xx）"
    }
    if ($Managed) {
        & $dotnetExe build CodexPhoneProxy.csproj -c Release -p:PublishAot=false
    } else {
        & $dotnetExe publish CodexPhoneProxy.csproj -c Release -r win-x64 -o (Join-Path $projectRoot 'build/publish')
    }
    if ($LASTEXITCODE -ne 0) { throw 'Proxy build failed' }
    if (-not $Managed) {
        $target = if ($OutputPath) { [IO.Path]::GetFullPath($OutputPath) } else { Join-Path $projectRoot 'dist/codex-phone.exe' }
        $running = Get-CimInstance Win32_Process -Filter "Name='codex-phone.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.ExecutablePath -eq $target }
        if ($running) { throw "代理正在运行，新构建保留在 build/publish；关闭使用它的扩展会话后再运行构建脚本：$target" }
        New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
        Copy-Item -LiteralPath (Join-Path $projectRoot 'build/publish/codex-phone.exe') -Destination $target -Force
        Write-Host "Proxy published: $target"
    }
} finally { Pop-Location }
