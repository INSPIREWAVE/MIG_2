#!/bin/bash
# M.I.G Loans - Electron Desktop Application Launcher (Unix/Linux/Mac)
# This script starts the app using the locally installed electron binary
# Ensures complete independence from global node installation

set -e

# Get the script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Check if electron exists
if [ ! -f "node_modules/.bin/electron" ]; then
    echo "Error: electron not found in node_modules/.bin"
    echo "Please run: npm install"
    exit 1
fi

# Run electron
echo "Starting M.I.G Loans Management System..."
./node_modules/.bin/electron .
