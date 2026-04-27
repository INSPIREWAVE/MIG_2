@echo off
REM M.I.G Loans - Build Portable Executable
REM This batch file builds the portable executable using locally installed electron-builder
REM Ensures complete independence from global node installation

setlocal enabledelayedexpansion

REM Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

REM Check if electron-builder exists
if not exist "node_modules\.bin\electron-builder.cmd" (
    echo Error: electron-builder not found in node_modules/.bin
    echo Please run: npm install --prefix . (or cd to this directory and run npm install)
    pause
    exit /b 1
)

REM Run electron-builder
echo Building M.I.G Loans Management System (Portable)...
call node_modules\.bin\electron-builder.cmd --win portable --publish never

echo.
echo Build complete. Executable created in: dist\
pause

endlocal
