@echo off
chcp 65001 >nul
net session >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
sc.exe stop CodexPhoneRelay >nul 2>&1
"%~dp0relay-server.exe" uninstall
pause
