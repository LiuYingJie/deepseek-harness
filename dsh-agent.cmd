@echo off
node "%~dp0dsh-agent.mjs" %*
exit /b %errorlevel%
