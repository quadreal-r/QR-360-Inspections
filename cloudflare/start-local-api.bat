@echo off
setlocal EnableExtensions
title INSP 360 Local API (8788)
cd /d "%~dp0"

set "URL=http://127.0.0.1:8788/"
set "HEALTH=http://127.0.0.1:8788/api/health"
set "NPM="

where npm.cmd >nul 2>&1 && set "NPM=npm.cmd"
if not defined NPM if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM=%ProgramFiles%\nodejs\npm.cmd"
if not defined NPM if exist "%LocalAppData%\Programs\node\npm.cmd" set "NPM=%LocalAppData%\Programs\node\npm.cmd"

if not defined NPM (
  echo ERROR: npm was not found.
  echo Install Node.js, or open a terminal where "npm" works, then try again.
  echo.
  pause
  exit /b 1
)

echo Starting INSP 360 local API...
echo   npm: %NPM%
echo   URL: %URL%
echo Close this window to stop the server.
echo.

REM Wait for /api/health, then open the browser (sync-viewer can take a few seconds)
start "INSP360-open" /min cmd /c "for /l %%i in (1,1,60) do @(curl.exe -fsS \"%HEALTH%\" >nul 2>&1 && start \"\" \"%URL%\" && exit /b 0 & timeout /t 1 /nobreak >nul) & echo Timed out waiting for local API. & pause"

call "%NPM%" run local-api
set "ERR=%ERRORLEVEL%"
echo.
if not "%ERR%"=="0" (
  echo Server exited with error code %ERR%.
) else (
  echo Server stopped.
)
pause
exit /b %ERR%
