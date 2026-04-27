@echo off
REM M.I.G Loans - Electron Desktop Application Launcher
REM This batch file starts the app using the locally installed electron binary
REM Ensures complete independence from global node installation

setlocal enabledelayedexpansion

REM Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

REM Check if node_modules/.bin/electron.cmd exists
if not exist "node_modules\.bin\electron.cmd" (
    echo Error: electron not found in node_modules/.bin
    echo Please run: npm install --prefix . (or cd to this directory and run npm install)
    pause
    exit /b 1
)

REM Run electron with the local binary
echo Starting M.I.G Loans Management System...
call node_modules\.bin\electron.cmd .

endlocal
