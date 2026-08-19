@echo off
rem Same as dsh-agent.cmd, A_-prefixed for grouping.
rem   A_dsh-agent.bat "<task>"          create a new agent
rem   A_dsh-agent.bat <ID> "<task>"     reuse an agent (carries its history)
rem   A_dsh-agent.bat --list            list all agents
node "%~dp0dsh-agent.mjs" %*
exit /b %errorlevel%
