$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$repositoryRoot = Split-Path -Parent $root
$protocol = Join-Path $repositoryRoot 'docs\relay\PROTOCOL.md'
& (Join-Path $PSScriptRoot 'build.ps1') -Configuration Release
$buildRoot = [IO.Path]::GetFullPath((Join-Path $root 'build'))
$stage = [IO.Path]::GetFullPath((Join-Path $buildRoot 'package'))
$zip = Join-Path $root 'dist\codex-phone-relay-windows-x64.zip'
if (-not $stage.StartsWith($buildRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Package staging directory must be inside the Relay build directory.'
}
if (Test-Path -LiteralPath $stage) {
    if ((Get-Item -LiteralPath $stage).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Package staging directory must not be a link.'
    }
    Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'dist\relay-server.exe'),(Join-Path $root 'config\relay-server.example.ini') -Destination $stage
$readme = @'
# Codex 手机中继（Windows x64）

本包使用 CPR2 协议，需要配套的 C# 手机桥。以下命令在解压目录的 PowerShell 中执行。

首次配置：

```powershell
Copy-Item -LiteralPath .\relay-server.example.ini -Destination .\relay-server.ini
```

编辑 relay-server.ini，将 shared_secret 替换为至少 32 个字符的随机密钥，
与电脑 config/phone-mode.ini 中的 relay.secret 一致。已有配置请继续使用。
默认需开放 TCP 8788（手机访问）和 8789（电脑手机桥连接）。

控制台运行：

```powershell
.\relay-server.exe run --config .\relay-server.ini
```

安装 Windows 服务前，将整个目录放到固定部署位置，以管理员身份执行：

```powershell
$configPath = (Resolve-Path -LiteralPath .\relay-server.ini).Path
.\relay-server.exe install --config $configPath
Start-Service CodexPhoneRelay
```

停止和卸载：

```powershell
Stop-Service CodexPhoneRelay
.\relay-server.exe uninstall
```

手机访问 http://服务器地址:8788/，连接口令使用电脑配置中的 phone.token。
CPR2 本身不加密，需要 HTTPS 时另行配置入口。
'@
[IO.File]::WriteAllText((Join-Path $stage 'README.md'), $readme + "`n", [Text.UTF8Encoding]::new($false))
if (Test-Path -LiteralPath $protocol -PathType Leaf) {
    Copy-Item -LiteralPath $protocol -Destination $stage
}
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal -Force
Get-FileHash -LiteralPath (Join-Path $root 'dist\relay-server.exe'),$zip -Algorithm SHA256
