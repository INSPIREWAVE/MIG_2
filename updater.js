/**
 * Auto-updater module for MIGL
 * Handles checking, downloading, and installing updates
 */

const { app, dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

function initUpdater(window) {
  mainWindow = window;
  
  // Configure updater
  autoUpdater.checkForUpdatesAndNotify();
  
  // Check for updates every 24 hours
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.error('[UPDATER] Check failed:', err);
    });
  }, 24 * 60 * 60 * 1000);
  
  // Update events
  autoUpdater.on('checking-for-update', () => {
    console.log('[UPDATER] Checking for updates...');
    if (mainWindow) mainWindow.webContents.send('updater:checking');
  });
  
  autoUpdater.on('update-available', (info) => {
    console.log('[UPDATER] Update available:', info.version);
    if (mainWindow) {
      mainWindow.webContents.send('updater:available', {
        version: info.version,
        releaseDate: info.releaseDate,
        files: info.files.length
      });
      
      // Auto-download in background
      autoUpdater.downloadUpdate();
    }
  });
  
  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) {
      mainWindow.webContents.send('updater:progress', {
        percent: progress.percent.toFixed(2),
        speed: (progress.bytesPerSecond / 1024 / 1024).toFixed(2),
        transferred: (progress.transferred / 1024 / 1024).toFixed(2),
        total: (progress.total / 1024 / 1024).toFixed(2)
      });
    }
  });
  
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[UPDATER] Update downloaded:', info.version);
    if (mainWindow) {
      mainWindow.webContents.send('updater:downloaded', { version: info.version });
      
      // Prompt to restart
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Ready',
        message: `Version ${info.version} is ready to install.`,
        buttons: ['Install Now', 'Later'],
        defaultId: 0
      }).then(result => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
    }
  });
  
  autoUpdater.on('error', (err) => {
    console.error('[UPDATER] Error:', err);
    if (mainWindow) {
      mainWindow.webContents.send('updater:error', { message: err.message });
    }
  });
}

// IPC handlers
function registerUpdaterIPC() {
  ipcMain.handle('updater:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return {
        current: app.getVersion(),
        available: result?.updateInfo?.version || null,
        hasUpdate: result?.updateInfo?.version && result.updateInfo.version !== app.getVersion()
      };
    } catch (err) {
      return { error: err.message };
    }
  });
  
  ipcMain.handle('updater:install', async () => {
    autoUpdater.quitAndInstall();
  });
  
  ipcMain.handle('updater:dismiss', async () => {
    // User dismissed update; no action needed
    return true;
  });
}

module.exports = {
  initUpdater,
  registerUpdaterIPC
};
