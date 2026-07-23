@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-RestMethod -Uri 'http://127.0.0.1:43821/health' -TimeoutSec 5; Write-Host 'AYCD helper is reachable.' -ForegroundColor Green; $r | ConvertTo-Json } catch { Write-Host 'AYCD helper is NOT running.' -ForegroundColor Red; Write-Host 'Double-click start-aycd-bridge.bat and KEEP its black window open.'; Write-Host $_.Exception.Message }"
pause
