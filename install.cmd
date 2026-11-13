@echo off
rem Install Corbot on Windows: double-click this file. See install.ps1 for what it does.
rem This wrapper only lets the script run whatever the PowerShell execution policy is.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set CORBOT_RC=%ERRORLEVEL%
echo.
pause
exit /b %CORBOT_RC%
