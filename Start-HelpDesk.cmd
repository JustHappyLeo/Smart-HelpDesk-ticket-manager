@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-HelpDesk.ps1"
if errorlevel 1 (
  echo.
  echo HelpDesk could not be started. Review the message above.
  pause
)
