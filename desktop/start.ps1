#!/usr/bin/env pwsh
# M.I.G Loans - Electron Desktop Application Launcher (PowerShell)
# This script starts the app using the locally installed electron binary
# Ensures complete independence from global node installation

$ErrorActionPreference = "Stop"

# Get the script directory
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# Check if electron exists
$ElectronPath = ".\node_modules\.bin\electron.cmd"
if (-not (Test-Path $ElectronPath)) {
    Write-Host "Error: electron not found in node_modules/.bin" -ForegroundColor Red
    Write-Host "Please run: npm install" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# Run electron
Write-Host "Starting M.I.G Loans Management System..." -ForegroundColor Green
& $ElectronPath .
