@echo off
setlocal
cd /d "%~dp0"

set "PORT=3080"
set "URL=http://127.0.0.1:%PORT%"

echo.
echo [DSH] DeepSeek Harness launcher
echo.

rem Already running?
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [DSH] Server already running at %URL%
    start "" "%URL%"
    exit /b 0
)

rem Check required commands
where node >nul 2>&1
if errorlevel 1 (
    echo [DSH] ERROR: node not found. Install Node.js and add it to PATH.
    pause
    exit /b 1
)
where pnpm >nul 2>&1
if errorlevel 1 (
    echo [DSH] ERROR: pnpm not found. Install pnpm first.
    pause
    exit /b 1
)

rem Ensure build artifacts exist; build once if missing (first start is slow)
if not exist "apps\web\dist\index.html" goto build
if not exist "packages\client\connection\lib\client.js" goto build
goto launch

:build
echo [DSH] Build artifacts missing. Running "pnpm run build" (first start may take minutes)...
call pnpm run build > build.log 2>&1
if errorlevel 1 (
    echo [DSH] Build FAILED. See build.log
    pause
    exit /b 1
)
echo [DSH] Build done.

:launch
echo [DSH] Starting web server (log: dsh-web.log)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'node' -ArgumentList @('--import','tsx/esm','apps/cli/src/bin.ts','web') -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%~dp0dsh-web.log' -RedirectStandardError '%~dp0dsh-web.err.log' -PassThru; $p.Id | Set-Content -Encoding ascii '%~dp0dsh-web.pid'"
if errorlevel 1 (
    echo [DSH] Failed to launch. See dsh-web.err.log
    pause
    exit /b 1
)

rem Wait for the port (max 30s)
set /a tries=0
:wait
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 goto up
set /a tries+=1
if %tries% geq 30 (
    echo [DSH] Server did not start within 30s. See dsh-web.err.log
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait

:up
echo [DSH] Server is up at %URL%
start "" "%URL%"
exit /b 0
