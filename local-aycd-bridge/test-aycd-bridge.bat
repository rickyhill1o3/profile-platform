@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-RestMethod -Uri 'http://127.0.0.1:43821/health' -TimeoutSec 5; Write-Host 'AYCD helper is reachable.' -ForegroundColor Green; $r | ConvertTo-Json } catch { Write-Host 'AYCD helper is NOT reachable.' -ForegroundColor Red; Write-Host 'Run start-aycd-bridge.bat and leave that window open.'; Write-Host $_.Exception.Message }"
pause
