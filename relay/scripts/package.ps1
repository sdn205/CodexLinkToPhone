$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'build.ps1') -Configuration Release
$stage = Join-Path $root 'build\package'
$zip = Join-Path $root 'dist\codex-phone-relay-windows-x64.zip'
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'dist\relay-server.exe'),(Join-Path $root 'README.md'),(Join-Path $root 'PROTOCOL.md'),(Join-Path $root 'config\relay-server.example.ini') -Destination $stage
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
Get-FileHash -LiteralPath (Join-Path $root 'dist\relay-server.exe'),$zip -Algorithm SHA256
