@echo off
rem Corbot on Windows: see corbot.ps1. This wrapper only lets the script run whatever the PowerShell execution policy is.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0corbot.ps1" %*
exit /b %ERRORLEVEL%
