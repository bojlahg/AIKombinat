@echo off
setlocal
title AIKombinat - Build and Start
cd /d "%~dp0.."
echo ========================================
echo   AIKombinat - Build and Start
echo ========================================
echo.

echo [1/3] Checking native modules...
call node "scripts\native-preflight.mjs"
if errorlevel 1 (
    echo.
    echo Native module preflight failed. Server was NOT started.
    echo.
    pause
    exit /b 1
)
echo.

echo [2/3] Building...
call npm run build
if errorlevel 1 (
    echo.
    echo Build failed. Server was NOT started.
    echo.
    pause
    exit /b 1
)
echo.

echo [3/3] Starting server...
echo.
call npm run start
set "EXITCODE=%errorlevel%"
if not "%EXITCODE%"=="0" (
    echo.
    echo Server exited with code %EXITCODE%.
    echo See the log file path printed above for details.
)
echo.
pause
exit /b %EXITCODE%
