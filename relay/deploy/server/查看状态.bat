@echo off
chcp 65001 >nul
sc.exe query CodexPhoneRelay
echo.
netstat -ano | findstr ":8788 :8789"
echo.
type "%~dp0relay-server.log"
pause
