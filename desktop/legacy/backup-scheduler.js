const path = require('path');
const fs = require('fs');
const config = require('../config');

// Backup scheduler for automatic database backups
class BackupScheduler {
  constructor(db) {
    this.db = db;
    this.scheduledBackup = null;
    this.isRunning = false;
  }

  /**
   * Initialize the backup scheduler
   * Loads settings and schedules next backup
   */
  start() {
    if (this.isRunning) {
      console.log('[BACKUP_SCHEDULER] Already running');
      return;
    }

    try {
      const settings = config.getBackupSettings();
      
      if (!settings.enabled) {
        console.log('[BACKUP_SCHEDULER] Backup scheduling disabled');
        return;
      }

      this.isRunning = true;
      console.log('[BACKUP_SCHEDULER] Started with frequency:', settings.frequency);
      
      this.scheduleNextBackup(settings.frequency);
    } catch (err) {
      console.error('[BACKUP_SCHEDULER] Error starting scheduler:', err.message);
    }
  }

  /**
   * Schedule the next backup based on frequency
   */
  scheduleNextBackup(frequency = 'daily') {
    if (this.scheduledBackup) {
      clearTimeout(this.scheduledBackup);
    }

    const nextTime = config.getNextBackupTime(frequency);
    const now = new Date();
    const delayMs = nextTime.getTime() - now.getTime();

    console.log('[BACKUP_SCHEDULER] Next backup scheduled for:', nextTime.toISOString());

    this.scheduledBackup = setTimeout(() => {
      this.executeBackup(frequency);
    }, delayMs);

    // Update config with next backup time
    config.setBackupSettings({
      nextBackupTime: nextTime.toISOString()
    });
  }

  /**
   * Execute a backup and cleanup old backups
   * @param {string} frequency - Backup frequency (daily/weekly/monthly)
   * @param {number} retryCount - Number of retries if backup fails (default 3)
   */
  async executeBackup(frequency = 'daily', retryCount = 3) {
    try {
      console.log('[BACKUP_SCHEDULER] Executing automatic backup...');

      if (!this.db) {
        throw new Error('Database not initialized');
      }

      // Create backup with retry logic
      let backupResult = null;
      let lastError = null;
      
      for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
          backupResult = this.db.createBackup('automatic');
          
          if (backupResult.success) {
            break; // Success, exit retry loop
          }
          
          lastError = backupResult.error || 'Unknown error';
          console.warn(`[BACKUP_SCHEDULER] Backup attempt ${attempt}/${retryCount} failed:`, lastError);
          
          // Wait before retry (exponential backoff)
          if (attempt < retryCount) {
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
          }
        } catch (err) {
          lastError = err.message;
          console.error(`[BACKUP_SCHEDULER] Backup attempt ${attempt}/${retryCount} error:`, err.message);
        }
      }
      
      if (!backupResult || !backupResult.success) {
        throw new Error('Database backup failed after ' + retryCount + ' attempts: ' + lastError);
      }

      console.log('[BACKUP_SCHEDULER] Backup created:', backupResult.name);

      // Verify backup integrity
      if (this.db.verifyDBIntegrity) {
        const integrityCheck = this.db.verifyDBIntegrity();
        if (!integrityCheck.valid) {
          console.warn('[BACKUP_SCHEDULER] Database integrity warning after backup:', integrityCheck);
        }
      }

      // Update config
      config.setBackupSettings({
        lastBackupTime: new Date().toISOString(),
        lastBackupStatus: 'success'
      });

      // Cleanup old backups (keep last N)
      const settings = config.getBackupSettings();
      this.cleanupOldBackups(settings.autoRetention || 5);

      // Schedule next backup
      this.scheduleNextBackup(frequency);

      return { success: true, backupId: backupResult.id, name: backupResult.name };
    } catch (err) {
      console.error('[BACKUP_SCHEDULER] Backup failed:', err.message);
      
      // Update config with failure status
      config.setBackupSettings({
        lastBackupTime: new Date().toISOString(),
        lastBackupStatus: 'failed',
        lastBackupError: err.message
      });
      
      // Still reschedule even if backup failed
      this.scheduleNextBackup(frequency);
      
      return { success: false, error: err.message };
    }
  }

  /**
   * Clean up old backups, keeping only recent ones
   */
  cleanupOldBackups(keepCount = 5) {
    try {
      const backups = this.db.getBackups();
      
      if (backups.length <= keepCount) {
        console.log('[BACKUP_SCHEDULER] Keeping all', backups.length, 'backups');
        return;
      }

      // Delete oldest backups
      const toDelete = backups.slice(keepCount);
      for (const backup of toDelete) {
        if (backup.id) {
          this.db.deleteBackup(backup.id);
          console.log('[BACKUP_SCHEDULER] Deleted old backup:', backup.backupName);
        }
      }

      console.log('[BACKUP_SCHEDULER] Cleaned up', toDelete.length, 'old backups');
    } catch (err) {
      console.error('[BACKUP_SCHEDULER] Cleanup failed:', err.message);
      // Don't throw, cleanup is non-critical
    }
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (this.scheduledBackup) {
      clearTimeout(this.scheduledBackup);
      this.scheduledBackup = null;
    }
    this.isRunning = false;
    console.log('[BACKUP_SCHEDULER] Stopped');
  }

  /**
   * Get current scheduler status
   */
  /**
   * Stop the backup scheduler
   */
  stop() {
    if (this.scheduledBackup) {
      clearTimeout(this.scheduledBackup);
      this.scheduledBackup = null;
    }
    this.isRunning = false;
    console.log('[BACKUP_SCHEDULER] Stopped');
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    const settings = config.getBackupSettings();
    return {
      running: this.isRunning,
      enabled: settings.enabled,
      frequency: settings.frequency,
      lastBackupTime: settings.lastBackupTime,
      nextBackupTime: settings.nextBackupTime,
      autoRetention: settings.autoRetention
    };
  }

  /**
   * Update backup settings and restart scheduler
   */
  updateSettings(newSettings) {
    try {
      const updated = config.setBackupSettings(newSettings);
      
      if (updated) {
        // Restart scheduler with new settings
        this.stop();
        this.start();
        return { success: true, message: 'Backup settings updated' };
      } else {
        return { success: false, error: 'Failed to save settings' };
      }
    } catch (err) {
      console.error('[BACKUP_SCHEDULER] Error updating settings:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Trigger an immediate backup
   */
  async backupNow() {
    try {
      return await this.executeBackup();
    } catch (err) {
      console.error('[BACKUP_SCHEDULER] Immediate backup failed:', err.message);
      return { success: false, error: err.message };
    }
  }
}

module.exports = BackupScheduler;
