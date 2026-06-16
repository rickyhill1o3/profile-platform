@echo off
echo Installing dependencies if needed...
call npm install
call npx playwright install chromium
echo Starting Target Local Login Tool...
echo Open http://localhost:7777 in Chrome if it does not open automatically.
start http://localhost:7777
call npm start
pause
