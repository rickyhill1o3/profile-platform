@echo off
echo Closing Chrome so it can restart with remote debugging...
taskkill /F /IM chrome.exe 2>NUL
echo Starting Chrome with remote debugging on port 9222...
start chrome.exe --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\target-login-profile"
echo.
echo Chrome is opening. Login to Target normally, then use the local tool Capture From Existing Chrome button.
pause
