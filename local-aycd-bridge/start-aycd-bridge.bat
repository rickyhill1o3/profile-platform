@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 22 LTS, then run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing the local AYCD bridge...
  call npm install
  if errorlevel 1 pause
)
echo Starting The Shore Shack AYCD bridge...
node bridge.js
pause
