# M.I.G Loans Desktop Application - Independent Setup

This folder contains the standalone Electron desktop application for M.I.G Loans Management. It is **completely independent** from the global Node.js installation and can run entirely on its own.

## Quick Start

### Option 1: Using Batch Scripts (Windows)
The simplest way to run the app:

```bash
# Start the application
start.bat

# Build portable executable
build.bat
```

### Option 2: Using npm (Any OS)
If you have npm available in this directory:

```bash
# Install dependencies (first time only)
npm install

# Start the application
npm start

# Or use the dev command
npm run dev

# Build the application
npm run build:win-portable
```

### Option 3: Using PowerShell (Windows)
```powershell
# Start the application
.\start.ps1

# Or with npm
npm start
```

### Option 4: Using Shell Script (Linux/Mac)
```bash
chmod +x start.sh
./start.sh
```

## Project Structure

```
desktop/
├── electron/              # Electron main process
│   ├── main.js           # Main process entry point
│   ├── preload.js        # IPC bridge to renderer
│   └── updater.js        # Auto-update configuration
├── index.html            # Main UI (single-file app ~38KB)
├── config/               # Runtime configuration
├── legacy/               # Legacy/compatibility modules
├── logo/                 # Company branding assets
├── scripts/              # Utility scripts
├── node_modules/         # Local dependencies (independent)
├── package.json          # Project manifest
├── start.bat             # Windows launcher
├── start.ps1             # PowerShell launcher
├── start.sh              # Unix/Linux launcher
└── build.bat             # Windows build script
```

## Installation

### First-Time Setup
1. Navigate to this directory (`desktop/`)
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the application:
   ```bash
   npm start
   ```
   Or use the launcher scripts above.

### Verified Dependency Versions
- **Node.js**: 18.x - 24.x (specified in package.json)
- **npm**: 11.12.1+
- **Electron**: 41.0.0
- **electron-builder**: 25.1.8

All dependencies are installed **locally** in `node_modules/` and do **not** require a global installation.

## Building

### Build Portable Executable (.exe)
```bash
npm run build:win-portable
```

Output will be in: `desktop/dist/MIGLoansManagement.exe`

### Build with Installer (NSIS)
```bash
npm run build:win
```

Output will include both `.exe` installer and portable versions.

### Build License Manager Utility
```bash
npm run build:license-manager
```

Creates: `dist/MIGL-License-Manager.exe`

## Configuration

### Company Settings
Edit `desktop/config/index.js` to customize:
- Company name, phone, email, address
- Bank details
- Branding colors and logos
- Feature flags

### Environment Variables
Create `.env` file in this directory:
```env
NODE_ENV=production
DEBUG=false
```

### Database
- SQLite: Stored in `data/` folder
- Backups: Automatic backups in `data/backups/`

## Scripts

All scripts in `package.json` use **locally installed binaries** (not global):

| Script | Purpose | Binary Used |
|--------|---------|-------------|
| `npm start` | Launch the app | `./node_modules/.bin/electron` |
| `npm run dev` | Development mode | `./node_modules/.bin/electron` |
| `npm run build` | Build (auto-detects OS) | `./node_modules/.bin/electron-builder` |
| `npm run build:win` | Windows NSIS + Portable | `./node_modules/.bin/electron-builder` |
| `npm run build:win-portable` | Windows Portable only | `./node_modules/.bin/electron-builder` |
| `npm run build:license-manager` | License manager tool | `./node_modules/.bin/pkg` |

## Troubleshooting

### "electron not found in node_modules"
**Solution**: Run `npm install` first to download dependencies.

### "Cannot find module" errors
**Solution**: Ensure you ran `npm install` and all `node_modules/` are present.

### Port conflicts
The app uses SQLite (no external ports needed) but checks for available ports for the IPC bridge.

### Windows Defender Warnings
Windows Defender may flag the portable `.exe`. This is normal for unsigned executables. The app is safe to allow.

### Build fails with "asar not found"
**Solution**: Clean and reinstall:
```bash
rmdir /s node_modules
npm install
npm run build:win-portable
```

## IPC API Reference

The desktop app uses Electron IPC for secure communication. See `electron/preload.js` for available API methods:

- `window.api.settings.*` - Company/user settings
- `window.api.files.*` - File operations
- `window.api.export.*` - Document generation
- `window.api.db.*` - Database queries
- `window.api.auth.*` - Authentication

## Independent Deployment

This desktop folder is **completely self-contained**:
- ✅ No global Node.js required
- ✅ No global npm required  
- ✅ All dependencies local (`node_modules/`)
- ✅ Can be deployed to isolated/offline machines
- ✅ Each instance can have different versions
- ✅ Easy cleanup: delete folder, all cleaned up

## License

ISC – See LICENSE file

## Support

For issues:
1. Check `data/logs/` for error logs
2. Ensure `node_modules/` is complete: `npm install`
3. Try rebuilding: `npm run build:win-portable`
4. Check that Windows can run the app (no UAC blocks, no antivirus blocks)

---

**Version**: 2.0.1  
**Last Updated**: April 2026  
**Platform**: Windows (x64, ia32), extensible to Mac/Linux
