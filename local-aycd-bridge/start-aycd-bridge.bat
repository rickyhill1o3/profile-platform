@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title The Shore Shack AYCD Bridge
color 0B

echo =============================================================
echo   THE SHORE SHACK - AYCD LOCAL BRIDGE
echo =============================================================
echo Folder: %CD%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or is not available in PATH.
  echo Install Node.js 22 LTS from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

echo Node version:
node --version
echo.

if not exist node_modules\imapflow\package.json (
  echo Installing bridge dependencies. This is required only once...
  call npm install --omit=dev --no-audit --no-fund > install-log.txt 2>&1
  if errorlevel 1 (
    echo.
    echo ERROR: Dependency installation failed.
    echo Open this file and send its contents for review:
    echo %CD%\install-log.txt
    echo.
    type install-log.txt
    pause
    exit /b 1
  )
)

echo Starting helper at http://127.0.0.1:43821
echo AYCD Inbox must remain open with IMAP Server enabled.
echo IMPORTANT: Leave this black window open.
echo.
node bridge.js

echo.
echo ERROR: The helper stopped. Review the message above.
pause
