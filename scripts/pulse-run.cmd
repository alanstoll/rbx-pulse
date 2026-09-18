@echo off
rem Scheduled job for Windows Task Scheduler: sync, extract, enrich. Logs to logs\.
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f "tokens=1-3 delims=/- " %%a in ("%DATE%") do set D=%%c-%%a-%%b
call npm run --silent pulse -- run >> "logs\pulse-%D%.log" 2>&1
exit /b %ERRORLEVEL%
