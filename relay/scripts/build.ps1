param([ValidateSet('Debug','Release')][string]$Configuration = 'Release')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio Installer was not found.' }
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual C++ x64 build tools are not installed.' }
$devcmd = Join-Path $vs 'Common7\Tools\VsDevCmd.bat'
$build = Join-Path $root 'build\cmake'
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $build,$dist | Out-Null
$command = 'call "{0}" -arch=x64 -host_arch=x64 && cmake -S "{1}" -B "{2}" -G "NMake Makefiles" -DCMAKE_BUILD_TYPE={3} && cmake --build "{2}" && copy /Y "{2}\relay-server.exe" "{4}\relay-server.exe"' -f $devcmd,$root,$build,$Configuration,$dist
cmd.exe /d /s /c $command
if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }
Get-Item (Join-Path $dist 'relay-server.exe') | Select-Object FullName,Length,LastWriteTime
