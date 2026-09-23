$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$buildDirectory = Join-Path $repoRoot 'tests\build\assistant'
& cmake -S (Join-Path $repoRoot 'assistant') -B $buildDirectory -A x64
if ($LASTEXITCODE -ne 0) { throw 'Assistant test configuration failed' }
& cmake --build $buildDirectory --config Release --target phone-assistant-tests phone-manager-tests
if ($LASTEXITCODE -ne 0) { throw 'Assistant test build failed' }
& ctest --test-dir $buildDirectory --output-on-failure -C Release
if ($LASTEXITCODE -ne 0) { throw 'Assistant native tests failed' }
