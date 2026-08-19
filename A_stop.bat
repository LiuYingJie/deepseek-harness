@echo off
setlocal
cd /d "%~dp0"

set "PORT=3080"

echo.
echo [DSH] DeepSeek Harness stopper
echo.

rem 1. Stop via PID file written by start.bat
if exist "dsh-web.pid" set /p DSH_PID=<dsh-web.pid
if defined DSH_PID taskkill /PID %DSH_PID% /T /F >nul 2>&1
del "dsh-web.pid" >nul 2>&1

rem 2. Fallback: kill whatever listens on the port (note: a non-DSH app on this port would also be killed)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
    taskkill /PID %%p /T /F >nul 2>&1
)

rem 3. Stop the dev:web client-plugin HMR watcher if running
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*dev-web.ts*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo [DSH] Stopped.
exit /b 0
