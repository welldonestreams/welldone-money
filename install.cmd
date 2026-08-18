@echo off
title WellDone Money - build installer
echo.
echo   ========================================
echo     WellDone Money  -  build the installer
echo   ========================================
echo.
echo   This BUILDS the installer from source. It needs Node.js.
echo   To just install the app, download Setup.exe from Releases.
echo.
where node >nul 2>nul
if errorlevel 1 goto NONODE

echo   [1/2] Installing dependencies
call npm install
if errorlevel 1 goto FAIL

echo   [2/2] Building installer
call npm run dist
if errorlevel 1 goto FAIL

echo.
echo   Done. Run dist\WellDone-Money-Setup-*.exe to install the app.
pause
exit /b 0

:NONODE
echo   Node.js is required. Download it from https://nodejs.org
pause
exit /b 1

:FAIL
echo   Something failed - see the output above.
pause
exit /b 1
