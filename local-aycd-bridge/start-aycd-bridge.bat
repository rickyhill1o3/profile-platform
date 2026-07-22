@echo off
setlocal
cd /d "%~dp0"
title The Shore Shack AYCD Bridge
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed.
  echo Install Node.js 22 LTS from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)
if not exist node_modules\imapflow (
  echo Installing the local AYCD bridge dependencies...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo Installation failed. Copy the error above and send it for review.
    pause
    exit /b 1
  )
)
echo.
echo Starting the local bridge...
echo AYCD Inbox must remain open with IMAP Server enabled.
echo Do not close this window.
echo.
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start \"\" http://127.0.0.1:43821/"
node bridge.js
echo.
echo The helper stopped. Review any error above.
pause
