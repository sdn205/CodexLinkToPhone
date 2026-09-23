param([switch]$KeepProcesses)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\relay"))
$exe = Join-Path $root 'dist\relay-server.exe'
if (-not (Test-Path -LiteralPath $exe)) { & (Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\relay'))) 'scripts\build.ps1') }
$testOutput = Join-Path $PSScriptRoot ('..\build\relay-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
New-Item -ItemType Directory -Path $testOutput -Force | Out-Null
$secret = 'local-integration-test-secret-0123456789'
$serverLog = Join-Path $testOutput 'test-server-output.log'
$agentLog = Join-Path $testOutput 'test-agent-output.log'
$echo = $null
$server = $null
$agent = $null
try {
    $echo = Start-Process -FilePath $exe -ArgumentList @('echo-server','--port','18888') -PassThru -WindowStyle Hidden
    $serverArgs = @('run','--public-bind','127.0.0.1','--public-port','18788','--agent-bind','127.0.0.1','--agent-port','18789','--secret',$secret,'--log',(Join-Path $testOutput 'integration-server.log'))
    $server = Start-Process -FilePath $exe -ArgumentList $serverArgs -RedirectStandardOutput $serverLog -RedirectStandardError ($serverLog + '.err') -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 500
    $agentArgs = @('test-agent','--server','127.0.0.1','--agent-port','18789','--secret',$secret,'--target','127.0.0.1','--target-port','18888')
    $agent = Start-Process -FilePath $exe -ArgumentList $agentArgs -RedirectStandardOutput $agentLog -RedirectStandardError ($agentLog + '.err') -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 700
    1..8 | ForEach-Object {
        $client = [Net.Sockets.TcpClient]::new()
        $client.Connect('127.0.0.1', 18788)
        $stream = $client.GetStream()
        $payload = [Text.Encoding]::UTF8.GetBytes("GET /relay-test/$_ HTTP/1.1`r`nHost: test`r`n`r`n" + ("x$_" * 25000))
        $stream.Write($payload, 0, $payload.Length)
        $received = New-Object byte[] $payload.Length
        $offset = 0
        $stream.ReadTimeout = 5000
        while ($offset -lt $received.Length) { $n = $stream.Read($received, $offset, $received.Length - $offset); if ($n -le 0) { break }; $offset += $n }
        $client.Dispose()
        if ($offset -ne $payload.Length) { throw "Length mismatch: expected $($payload.Length), got $offset" }
        if ([Convert]::ToBase64String($received) -ne [Convert]::ToBase64String($payload)) { throw 'Payload mismatch.' }
    }
    Write-Output 'PASS: 8 sequential connections preserved all bytes.'
    $bad = Start-Process -FilePath $exe -ArgumentList @('test-agent','--server','127.0.0.1','--agent-port','18789','--secret','wrong-secret-value-0000000000000000') -PassThru -Wait -WindowStyle Hidden
    if ($bad.ExitCode -eq 0) { throw 'Wrong secret was accepted.' }
    Write-Output 'PASS: wrong Agent secret was rejected.'
} finally {
    if (-not $KeepProcesses) {
        if ($agent -and -not $agent.HasExited) { Stop-Process -Id $agent.Id -Force }
        if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
        if ($echo -and -not $echo.HasExited) { Stop-Process -Id $echo.Id -Force }
    }
}
