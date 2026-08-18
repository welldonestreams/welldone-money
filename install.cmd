@echo off
title WellDone Money installer
echo.
echo   ========================================
echo     WellDone Money  -  installer
echo   ========================================
echo.
echo   This builds and installs the desktop app.
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
echo   Done. Run the installer in dist\ to install WellDone Money.
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
