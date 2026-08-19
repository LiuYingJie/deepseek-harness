@echo off
setlocal
set "TARGET=%~dp0"
if "%TARGET:~-1%"=="\" set "TARGET=%TARGET:~0,-1%"

echo.
echo [DSH] Register tool directory into user PATH
echo.

set "DSH_TOOL_DIR=%TARGET%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$dir = $env:DSH_TOOL_DIR; $p = [Environment]::GetEnvironmentVariable('Path','User'); $parts = $p -split ';' | Where-Object { $_ -and $_ -ne $dir -and $_ -ne ($dir + '\') }; $new = ($parts + $dir) -join ';'; if ($new -eq $p) { Write-Host ('Already registered: ' + $dir) } else { [Environment]::SetEnvironmentVariable('Path', $new, 'User'); Write-Host ('Registered into user PATH: ' + $dir) }"

echo.
echo NOTE: open a NEW terminal (or restart VSCode) for PATH to take effect.
echo Then verify with:  where dsh-agent
echo.
pause
