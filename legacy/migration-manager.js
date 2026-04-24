const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('../src/config');

/**
 * Migration Manager
 * Handles data migrations between storage locations and provides backup/restore utilities
 */
class MigrationManager {
  constructor() {
    this.isRunning = false;
    this.progress = {
      current: 0,
      total: 0,
      percentage: 0,
      status: 'idle',
      message: ''
    };
  }

  /**
   * Get current migration progress
   */
  getProgress() {
    return { ...this.progress };
  }

  /**
   * Analyze source directory for migration
   */
  analyzeDirectory(sourcePath) {
    try {
      if (!fs.existsSync(sourcePath)) {
        return { success: false, error: 'Source directory not found' };
      }

      const stats = {
        hasDatabase: false,
        hasBackups: false,
        hasClientFiles: false,
        databaseSize: 0,
        backupsSize: 0,
        clientFilesSize: 0,
        totalSize: 0,
        itemCount: 0
      };

      // Check for database
      const dbPath = path.join(sourcePath, 'data', 'migl.db');
      if (fs.existsSync(dbPath)) {
        stats.hasDatabase = true;
        stats.databaseSize = fs.statSync(dbPath).size;
        stats.totalSize += stats.databaseSize;
      }

      // Check for backups
      const backupsPath = path.join(sourcePath, 'data', 'backups');
      if (fs.existsSync(backupsPath)) {
        stats.hasBackups = true;
        const backupFiles = fs.readdirSync(backupsPath);
        stats.itemCount += backupFiles.length;
        backupFiles.forEach(file => {
          const filePath = path.join(backupsPath, file);
          if (fs.statSync(filePath).isFile()) {
            stats.backupsSize += fs.statSync(filePath).size;
          }
        });
        stats.totalSize += stats.backupsSize;
      }

      // Check for client files
      const clientFilesPath = path.join(sourcePath, 'ClientFiles');
      if (fs.existsSync(clientFilesPath)) {
        stats.hasClientFiles = true;
        const clientCount = this.countFiles(clientFilesPath);
        stats.itemCount += clientCount;
        stats.clientFilesSize = this.getDirectorySize(clientFilesPath);
        stats.totalSize += stats.clientFilesSize;
      }

      return {
        success: true,
        stats,
        hasMigrationData: stats.hasDatabase || stats.hasBackups || stats.hasClientFiles
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Count files in directory recursively
   */
  countFiles(dirPath) {
    let count = 0;
    try {
      const items = fs.readdirSync(dirPath);
      items.forEach(item => {
        const itemPath = path.join(dirPath, item);
        const stat = fs.statSync(itemPath);
        if (stat.isFile()) {
          count++;
        } else if (stat.isDirectory()) {
          count += this.countFiles(itemPath);
        }
      });
    } catch (err) {
      console.error('[MIGRATION] Error counting files:', err.message);
    }
    return count;
  }

  /**
   * Get directory size recursively
   */
  getDirectorySize(dirPath) {
    let size = 0;
    try {
      const items = fs.readdirSync(dirPath);
      items.forEach(item => {
        const itemPath = path.join(dirPath, item);
        const stat = fs.statSync(itemPath);
        if (stat.isFile()) {
          size += stat.size;
        } else if (stat.isDirectory()) {
          size += this.getDirectorySize(itemPath);
        }
      });
    } catch (err) {
      console.error('[MIGRATION] Error calculating directory size:', err.message);
    }
    return size;
  }

  /**
   * Perform data migration from source to destination
   */
  async migrateData(sourcePath, destinationPath) {
    return new Promise((resolve) => {
      try {
        this.isRunning = true;
        this.progress = {
          current: 0,
          total: 0,
          percentage: 0,
          status: 'analyzing',
          message: 'Analyzing source directory...'
        };

        // Validate paths
        if (!fs.existsSync(sourcePath)) {
          return resolve({ success: false, error: 'Source directory not found' });
        }

        if (!fs.existsSync(destinationPath)) {
          fs.mkdirSync(destinationPath, { recursive: true });
        }

        // Analyze source
        const analysis = this.analyzeDirectory(sourcePath);
        if (!analysis.success || !analysis.hasMigrationData) {
          return resolve({ 
            success: false, 
            error: analysis.error || 'No migration data found' 
          });
        }

        const stats = analysis.stats;
        this.progress.total = stats.itemCount + 3; // +3 for non-file items

        // Copy database
        this.progress.status = 'copying_database';
        this.progress.message = 'Copying database...';
        const dbSourcePath = path.join(sourcePath, 'data', 'migl.db');
        if (fs.existsSync(dbSourcePath)) {
          const dbDestPath = path.join(destinationPath, 'data');
          if (!fs.existsSync(dbDestPath)) {
            fs.mkdirSync(dbDestPath, { recursive: true });
          }
          fs.copyFileSync(dbSourcePath, path.join(dbDestPath, 'migl.db'));
          this.progress.current++;
          this.progress.percentage = Math.round((this.progress.current / this.progress.total) * 100);
        }

        // Copy backups
        this.progress.status = 'copying_backups';
        this.progress.message = 'Copying backups...';
        const backupsSourcePath = path.join(sourcePath, 'data', 'backups');
        if (fs.existsSync(backupsSourcePath)) {
          const backupsDestPath = path.join(destinationPath, 'data', 'backups');
          if (!fs.existsSync(backupsDestPath)) {
            fs.mkdirSync(backupsDestPath, { recursive: true });
          }
          this.copyDirectoryRecursive(backupsSourcePath, backupsDestPath, (count) => {
            this.progress.current += count;
            this.progress.percentage = Math.round((this.progress.current / this.progress.total) * 100);
          });
        }

        // Copy client files
        this.progress.status = 'copying_client_files';
        this.progress.message = 'Copying client files...';
        const clientFilesSourcePath = path.join(sourcePath, 'ClientFiles');
        if (fs.existsSync(clientFilesSourcePath)) {
          const clientFilesDestPath = path.join(destinationPath, 'ClientFiles');
          if (!fs.existsSync(clientFilesDestPath)) {
            fs.mkdirSync(clientFilesDestPath, { recursive: true });
          }
          this.copyDirectoryRecursive(clientFilesSourcePath, clientFilesDestPath, (count) => {
            this.progress.current += count;
            this.progress.percentage = Math.round((this.progress.current / this.progress.total) * 100);
          });
        }

        this.progress.status = 'finalizing';
        this.progress.message = 'Finalizing migration...';
        this.progress.current = this.progress.total;
        this.progress.percentage = 100;

        this.isRunning = false;
        resolve({
          success: true,
          message: 'Data migration completed successfully',
          stats: {
            databaseCopied: stats.hasDatabase,
            backupsCopied: stats.hasBackups,
            clientFilesCopied: stats.hasClientFiles,
            totalItemsCopied: stats.itemCount,
            totalSize: stats.totalSize
          }
        });
      } catch (err) {
        this.isRunning = false;
        console.error('[MIGRATION] Error:', err.message);
        resolve({ success: false, error: err.message });
      }
    });
  }

  /**
   * Copy directory recursively with progress callback
   */
  copyDirectoryRecursive(source, destination, onProgress) {
    try {
      if (!fs.existsSync(destination)) {
        fs.mkdirSync(destination, { recursive: true });
      }

      const files = fs.readdirSync(source);
      let copiedCount = 0;

      files.forEach(file => {
        const sourcePath = path.join(source, file);
        const destPath = path.join(destination, file);
        const stat = fs.statSync(sourcePath);

        if (stat.isDirectory()) {
          this.copyDirectoryRecursive(sourcePath, destPath, onProgress);
        } else {
          fs.copyFileSync(sourcePath, destPath);
          copiedCount++;
        }
      });

      if (onProgress && copiedCount > 0) {
        onProgress(copiedCount);
      }
    } catch (err) {
      console.error('[MIGRATION] Directory copy error:', err.message);
    }
  }

  /**
   * Export data as JSON for backup/transfer
   */
  async exportData(exportPath, includeOptions = {}) {
    try {
      const defaults = {
        clients: true,
        loans: true,
        payments: true,
        penalties: true,
        collateral: true,
        settings: true,
        auditLog: false // Large, optional
      };
      const options = { ...defaults, ...includeOptions };

      const exportData = {
        version: '2.0.0',
        exportDate: new Date().toISOString(),
        data: {}
      };

      // Export clients
      if (options.clients) {
        exportData.data.clients = db.exec('SELECT * FROM clients');
      }

      // Export loans
      if (options.loans) {
        exportData.data.loans = db.exec('SELECT * FROM loans');
      }

      // Export payments
      if (options.payments) {
        exportData.data.payments = db.exec('SELECT * FROM payments');
      }

      // Export penalties
      if (options.penalties) {
        exportData.data.penalties = db.exec('SELECT * FROM penalties');
      }

      // Export collateral
      if (options.collateral) {
        exportData.data.collateral = db.exec('SELECT * FROM collateral');
      }

      // Export settings
      if (options.settings) {
        exportData.data.settings = db.exec('SELECT * FROM settings');
      }

      // Export audit log (very large, use with caution)
      if (options.auditLog) {
        exportData.data.auditLog = db.exec('SELECT * FROM audit_log');
      }

      // Write to file
      const exportContent = JSON.stringify(exportData, null, 2);
      fs.writeFileSync(exportPath, exportContent, 'utf-8');

      return {
        success: true,
        message: 'Data exported successfully',
        path: exportPath,
        size: exportContent.length
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Import data from JSON export
   */
  async importData(importPath) {
    try {
      if (!fs.existsSync(importPath)) {
        return { success: false, error: 'Import file not found' };
      }

      const content = fs.readFileSync(importPath, 'utf-8');
      const importData = JSON.parse(content);

      if (!importData.version) {
        return { success: false, error: 'Invalid import file format' };
      }

      let importedCounts = {
        clients: 0,
        loans: 0,
        payments: 0,
        penalties: 0,
        collateral: 0
      };

      // Import clients
      if (importData.data.clients && Array.isArray(importData.data.clients)) {
        importData.data.clients.forEach(client => {
          try {
            db.addClient(client);
            importedCounts.clients++;
          } catch (err) {
            console.warn('[MIGRATION] Error importing client:', err.message);
          }
        });
      }

      // Import loans
      if (importData.data.loans && Array.isArray(importData.data.loans)) {
        importData.data.loans.forEach(loan => {
          try {
            db.addLoan(loan);
            importedCounts.loans++;
          } catch (err) {
            console.warn('[MIGRATION] Error importing loan:', err.message);
          }
        });
      }

      // Import payments
      if (importData.data.payments && Array.isArray(importData.data.payments)) {
        importData.data.payments.forEach(payment => {
          try {
            db.addPayment(payment);
            importedCounts.payments++;
          } catch (err) {
            console.warn('[MIGRATION] Error importing payment:', err.message);
          }
        });
      }

      // Import penalties
      if (importData.data.penalties && Array.isArray(importData.data.penalties)) {
        importData.data.penalties.forEach(penalty => {
          try {
            db.addPenalty(penalty);
            importedCounts.penalties++;
          } catch (err) {
            console.warn('[MIGRATION] Error importing penalty:', err.message);
          }
        });
      }

      // Import collateral
      if (importData.data.collateral && Array.isArray(importData.data.collateral)) {
        importData.data.collateral.forEach(item => {
          try {
            db.addCollateral(item);
            importedCounts.collateral++;
          } catch (err) {
            console.warn('[MIGRATION] Error importing collateral:', err.message);
          }
        });
      }

      db.saveDB();

      return {
        success: true,
        message: 'Data imported successfully',
        counts: importedCounts
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Get migration source candidates (find old data installations)
   */
  findMigrationCandidates() {
    const candidates = [];
    try {
      const appDataDir = require('electron').app.getPath('userData');
      const parentDir = path.dirname(appDataDir);

      // Check common locations
      const searchPaths = [
        path.join(appDataDir, '..'),
        path.join(require('os').homedir(), 'M.I.G'),
        path.join(require('os').homedir(), 'MIGL'),
        path.join(require('os').homedir(), 'MIG'),
        path.join(require('os').homedir(), 'AppData', 'Local', 'M.I.G'),
      ];

      searchPaths.forEach(searchPath => {
        try {
          if (fs.existsSync(searchPath)) {
            const analysis = this.analyzeDirectory(searchPath);
            if (analysis.success && analysis.hasMigrationData) {
              candidates.push({
                path: searchPath,
                stats: analysis.stats
              });
            }
          }
        } catch (err) {
          // Silently skip inaccessible paths
        }
      });

      return candidates;
    } catch (err) {
      console.error('[MIGRATION] Error finding candidates:', err.message);
      return [];
    }
  }

  /**
   * Verify migration integrity
   */
  verifyMigration(sourcePath, destinationPath) {
    try {
      const sourceAnalysis = this.analyzeDirectory(sourcePath);
      const destAnalysis = this.analyzeDirectory(destinationPath);

      if (!sourceAnalysis.success || !destAnalysis.success) {
        return { success: false, error: 'Could not analyze directories' };
      }

      const verification = {
        databaseVerified: sourceAnalysis.stats.hasDatabase === destAnalysis.stats.hasDatabase,
        backupsVerified: sourceAnalysis.stats.hasBackups === destAnalysis.stats.hasBackups,
        clientFilesVerified: sourceAnalysis.stats.hasClientFiles === destAnalysis.stats.hasClientFiles,
        itemCountMatch: sourceAnalysis.stats.itemCount === destAnalysis.stats.itemCount,
        allVerified: true
      };

      verification.allVerified = 
        verification.databaseVerified && 
        verification.backupsVerified && 
        verification.clientFilesVerified &&
        verification.itemCountMatch;

      return { success: true, verification };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

module.exports = MigrationManager;
