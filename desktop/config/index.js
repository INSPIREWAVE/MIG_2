const path = require('path');
const fs = require('fs');
const os = require('os');

// Config file location
let configPath = null;

// Gets user data path using Node.js instead of relying on app.getPath()
// This works both before and after app is ready
function getUserDataPath() {
  const platform = process.platform;
  if (platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'MIG');
  } else if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'MIG');
  } else {
    return path.join(os.homedir(), '.config', 'MIG');
  }
}

function getConfigPath() {
  if (configPath) return configPath;
  
  // Store config in user's home directory, platform-specific
  configPath = path.join(getUserDataPath(), 'migl-config.json');
  return configPath;
}

function getDefaultConfig() {
  return {
    version: '2.0.1',
    dataDirectory: getUserDataPath(),
    hasCompletedSetup: false,
    setupDate: null,
    lastLaunch: null,
    theme: 'dark',
    language: 'en',
    backup: {
      enabled: true,
      frequency: 'daily', // 'hourly', 'daily', 'weekly', 'monthly'
      lastBackupTime: null,
      nextBackupTime: null,
      autoRetention: 5 // Keep last 5 backups
    }
  };
}

function readConfig() {
  try {
    const configFile = getConfigPath();
    if (fs.existsSync(configFile)) {
      const content = fs.readFileSync(configFile, 'utf-8');
      const parsed = JSON.parse(content);
      
      // SECURITY: Validate config structure
      const validConfig = validateConfigSchema(parsed);
      if (!validConfig) {
        console.warn('[CONFIG] Invalid config structure, using defaults');
        return getDefaultConfig();
      }
      
      return parsed;
    }
    return getDefaultConfig();
  } catch (err) {
    console.error('[CONFIG] Error reading config:', err.message);
    return getDefaultConfig();
  }
}

function validateConfigSchema(config) {
  // Validate required top-level properties
  if (!config || typeof config !== 'object') return false;
  if (typeof config.version !== 'string') return false;
  if (typeof config.dataDirectory !== 'string') return false;
  if (typeof config.hasCompletedSetup !== 'boolean') return false;
  if (config.theme && typeof config.theme !== 'string') return false;
  if (config.language && typeof config.language !== 'string') return false;
  if (config.backup && typeof config.backup !== 'object') return false;
  
  return true;
}

function writeConfig(config) {
  try {
    const configFile = getConfigPath();
    const configDir = path.dirname(configFile);
    
    // Ensure config directory exists
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    // Write config atomically
    const tempPath = configFile + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2));
    
    // Replace original with temp (atomic on most systems)
    if (fs.existsSync(configFile)) {
      fs.unlinkSync(configFile);
    }
    fs.renameSync(tempPath, configFile);
    
    return true;
  } catch (err) {
    console.error('[CONFIG] Error writing config:', err.message);
    return false;
  }
}

function initializeDataDirectory(dataDir) {
  try {
    // Validate directory
    if (!dataDir || typeof dataDir !== 'string') {
      throw new Error('Invalid data directory path');
    }
    
    // Create directory structure
    const dirs = [
      dataDir,
      path.join(dataDir, 'data'),
      path.join(dataDir, 'data', 'backups'),
      path.join(dataDir, 'ClientFiles'),
      path.join(dataDir, 'logs'),
      path.join(dataDir, 'exports')
    ];
    
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    
    return true;
  } catch (err) {
    console.error('[CONFIG] Error initializing data directory:', err.message);
    return false;
  }
}

function validateDataDirectory(dataDir) {
  try {
    // Check if path exists
    if (!fs.existsSync(dataDir)) {
      return { valid: false, error: 'Directory does not exist' };
    }
    
    // Check if readable/writable
    fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
    
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

function getDataDirectory() {
  const config = readConfig();
  return config.dataDirectory;
}

function setDataDirectory(dataDir) {
  try {
    // Validate directory
    const validation = validateDataDirectory(dataDir);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
    
    // Initialize directory structure
    const initialized = initializeDataDirectory(dataDir);
    if (!initialized) {
      return { success: false, error: 'Failed to initialize directory structure' };
    }
    
    // Update config
    const config = readConfig();
    config.dataDirectory = dataDir;
    config.hasCompletedSetup = true;
    config.setupDate = new Date().toISOString();
    
    if (writeConfig(config)) {
      return { success: true, dataDirectory: dataDir };
    } else {
      return { success: false, error: 'Failed to save configuration' };
    }
  } catch (err) {
    console.error('[CONFIG] Error setting data directory:', err.message);
    return { success: false, error: err.message };
  }
}

function hasCompletedSetup() {
  const config = readConfig();
  return config.hasCompletedSetup === true;
}

function updateLastLaunch() {
  try {
    const config = readConfig();
    config.lastLaunch = new Date().toISOString();
    writeConfig(config);
  } catch (err) {
    console.error('[CONFIG] Error updating last launch:', err.message);
  }
}

function migrateFromOldLocation() {
  try {
    const config = readConfig();
    
    // If already set up, no migration needed
    if (config.hasCompletedSetup) {
      return { needsMigration: false };
    }
    
    // Check for old location
    const oldLocation = getUserDataPath();
    const hasOldData = fs.existsSync(path.join(oldLocation, 'data')) && 
                       fs.existsSync(path.join(oldLocation, 'data', 'migl360.db'));
    
    if (hasOldData) {
      return { 
        needsMigration: true, 
        oldLocation: oldLocation,
        hasDatabase: true
      };
    }
    
    return { needsMigration: false };
  } catch (err) {
    console.error('[CONFIG] Error checking for old location:', err.message);
    return { needsMigration: false };
  }
}

function migrateDataDirectory(fromDir, toDir) {
  try {
    // Validate source and destination
    if (!fs.existsSync(fromDir)) {
      return { success: false, error: 'Source directory does not exist' };
    }
    
    const validation = validateDataDirectory(toDir);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
    
    // Initialize destination structure
    initializeDataDirectory(toDir);
    
    // Copy data folder (database and backups)
    const sourceDataDir = path.join(fromDir, 'data');
    const destDataDir = path.join(toDir, 'data');
    
    if (fs.existsSync(sourceDataDir)) {
      copyDirectoryRecursive(sourceDataDir, destDataDir);
    }
    
    // Copy ClientFiles folder
    const sourceClientFiles = path.join(fromDir, 'ClientFiles');
    const destClientFiles = path.join(toDir, 'ClientFiles');
    
    if (fs.existsSync(sourceClientFiles)) {
      copyDirectoryRecursive(sourceClientFiles, destClientFiles);
    }
    
    // Copy logs folder
    const sourceLogs = path.join(fromDir, 'logs');
    const destLogs = path.join(toDir, 'logs');
    
    if (fs.existsSync(sourceLogs)) {
      copyDirectoryRecursive(sourceLogs, destLogs);
    }
    
    // Update config
    const config = readConfig();
    config.dataDirectory = toDir;
    config.hasCompletedSetup = true;
    config.setupDate = new Date().toISOString();
    
    if (writeConfig(config)) {
      return { 
        success: true, 
        dataDirectory: toDir,
        message: 'Data migrated successfully'
      };
    } else {
      return { success: false, error: 'Failed to save configuration' };
    }
  } catch (err) {
    console.error('[CONFIG] Error migrating data:', err.message);
    return { success: false, error: err.message };
  }
}

function copyDirectoryRecursive(source, destination) {
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(destination, { recursive: true });
  }
  
  const files = fs.readdirSync(source);
  
  for (const file of files) {
    const sourcePath = path.join(source, file);
    const destPath = path.join(destination, file);
    const stat = fs.statSync(sourcePath);
    
    if (stat.isDirectory()) {
      copyDirectoryRecursive(sourcePath, destPath);
    } else {
      fs.copyFileSync(sourcePath, destPath);
    }
  }
}

function getBackupSettings() {
  try {
    const cfg = readConfig();
    return cfg.backup || getDefaultConfig().backup;
  } catch (err) {
    console.error('[CONFIG] Error reading backup settings:', err.message);
    return getDefaultConfig().backup;
  }
}

function setBackupSettings(backupSettings) {
  try {
    const cfg = readConfig();
    cfg.backup = {
      ...cfg.backup,
      ...backupSettings
    };
    return writeConfig(cfg);
  } catch (err) {
    console.error('[CONFIG] Error setting backup settings:', err.message);
    return false;
  }
}

function getNextBackupTime(frequencyType = 'daily') {
  const now = new Date();
  let nextTime = new Date(now);

  switch (frequencyType) {
    case 'hourly':
      nextTime.setHours(nextTime.getHours() + 1);
      nextTime.setMinutes(0, 0, 0);
      break;
    case 'daily':
      nextTime.setDate(nextTime.getDate() + 1);
      nextTime.setHours(2, 0, 0, 0); // 2 AM
      break;
    case 'weekly':
      nextTime.setDate(nextTime.getDate() + (7 - nextTime.getDay())); // Next Sunday
      nextTime.setHours(2, 0, 0, 0);
      break;
    case 'monthly':
      nextTime = new Date(nextTime.getFullYear(), nextTime.getMonth() + 1, 1);
      nextTime.setHours(2, 0, 0, 0);
      break;
    default:
      nextTime.setDate(nextTime.getDate() + 1);
      nextTime.setHours(2, 0, 0, 0);
  }

  return nextTime;
}

module.exports = {
  getConfigPath,
  readConfig,
  writeConfig,
  getDataDirectory,
  setDataDirectory,
  hasCompletedSetup,
  updateLastLaunch,
  validateDataDirectory,
  initializeDataDirectory,
  migrateFromOldLocation,
  migrateDataDirectory,
  getDefaultConfig,
  getBackupSettings,
  setBackupSettings,
  getNextBackupTime
};
