const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
// Attempt to use electron-is-dev, but fall back to a robust runtime detection
let isDev;
try {
  isDev = require('electron-is-dev');
} catch (e) {
  // Fallback detection when module isn't available in production build
  isDev = (process.env.NODE_ENV === 'development') || process.defaultApp || /[\\/]electron-prebuilt[\\/]/.test(process.execPath) || /[\\/]electron[\\/]/.test(process.execPath);
}
const db = require('./db');
const config = require('./config');
const BackupScheduler = require('./backup-scheduler');
const MigrationManager = require('./migration-manager');
const CollateralManager = require('./collateral-manager');
// Get version from package.json instead of app.getVersion() to avoid timing issues
const { version: APP_VERSION } = require('./package.json');
const licenseValidatorV2 = require('./license-validator-v2');

// ===== GLOBAL ERROR HANDLERS (CRITICAL SECURITY) =====
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED_REJECTION]', { reason: reason?.message || reason, stack: reason?.stack });
  // Log to production log
  try {
    const logDir = path.join(config.getDataDirectory?.() || __dirname, 'data', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'error.log'), 
      `[${new Date().toISOString()}] UNHANDLED_REJECTION: ${reason?.message || reason}\n${reason?.stack || ''}\n`);
  } catch (e) { /* ignore logging errors */ }
});

process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT_EXCEPTION]', { error: error?.message, stack: error?.stack });
  // Log to production log
  try {
    const logDir = path.join(config.getDataDirectory?.() || __dirname, 'data', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'error.log'), 
      `[${new Date().toISOString()}] UNCAUGHT_EXCEPTION: ${error?.message}\n${error?.stack || ''}\n`);
  } catch (e) { /* ignore logging errors */ }
  // Don't exit in production - try to continue
  if (!isDev) return;
});

// ===== PRODUCTION MODE FLAG =====
const PRODUCTION_MODE = !isDev && process.env.NODE_ENV !== 'development';

// ===== PRODUCTION SECURITY =====
const rateLimitStore = new Map(); // Track request rates per user
const sessionStore = new Map(); // Track active sessions for auth validation
const MAX_REQUESTS_PER_MINUTE = 100;
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Session Management
function setSession(userId, userData) {
  sessionStore.set(userId, { ...userData, lastActivity: Date.now() });
}

function getSession(userId) {
  const session = sessionStore.get(userId);
  if (!session) return null;
  if (Date.now() - session.lastActivity > SESSION_TIMEOUT) {
    sessionStore.delete(userId);
    return null;
  }
  session.lastActivity = Date.now();
  return session;
}

function clearSession(userId) {
  sessionStore.delete(userId);
}

// Get current logged-in user from renderer (stored in session)
let currentUserId = null;
let currentUserRole = null;

function setCurrentUser(userId, role) {
  currentUserId = userId;
  currentUserRole = role;
}

function getCurrentUser() {
  return { id: currentUserId, role: currentUserRole };
}

// Authorization check for privilege escalation
function requireAdmin(handler) {
  return async (event, ...args) => {
    const user = getCurrentUser();
    if (!user.id || user.role !== 'admin') {
      console.warn('[AUTH] Unauthorized access attempt to admin function');
      return { success: false, error: 'Administrator privileges required' };
    }
    return handler(event, ...args);
  };
}

function requireAuth(handler) {
  return async (event, ...args) => {
    const user = getCurrentUser();
    if (!user.id) {
      console.warn('[AUTH] Unauthorized access attempt - no user logged in');
      return { success: false, error: 'Authentication required' };
    }
    return handler(event, ...args);
  };
}

// IPC Validation Middleware with improved error handling
function validateIPC(schema) {
  return (handler) => {
    return async (event, ...args) => {
      try {
        // Basic input validation
        if (schema.maxArgsLength && args.length > schema.maxArgsLength) {
          throw new Error('Too many arguments');
        }
        if (schema.argTypes) {
          for (let i = 0; i < schema.argTypes.length; i++) {
            const expectedType = schema.argTypes[i];
            if (expectedType && typeof args[i] !== expectedType) {
              throw new Error(`Arg ${i} must be ${expectedType}, got ${typeof args[i]}`);
            }
          }
        }
        // Validate required fields if schema specifies them
        if (schema.requiredFields && args[0] && typeof args[0] === 'object') {
          for (const field of schema.requiredFields) {
            if (args[0][field] === undefined || args[0][field] === null || args[0][field] === '') {
              throw new Error(`Missing required field: ${field}`);
            }
          }
        }
        return await handler(event, ...args);
      } catch (err) {
        console.error('[IPC_VALIDATION_ERROR]', schema.name, err.message);
        return { success: false, error: 'Invalid request', details: isDev ? err.message : 'Validation failed' };
      }
    };
  };
}

// Rate limiter
function checkRateLimit(channel) {
  const key = `${channel}:${Date.now() / RATE_LIMIT_WINDOW | 0}`;
  const count = (rateLimitStore.get(key) || 0) + 1;
  rateLimitStore.set(key, count);
  
  // Cleanup old entries periodically (prevent memory leak)
  if (rateLimitStore.size > 1000) {
    const now = Date.now();
    for (const [k] of rateLimitStore) {
      const windowTime = parseInt(k.split(':')[1]) * RATE_LIMIT_WINDOW;
      if (now - windowTime > RATE_LIMIT_WINDOW * 2) {
        rateLimitStore.delete(k);
      }
    }
  }
  
  if (count > MAX_REQUESTS_PER_MINUTE) {
    throw new Error('Rate limit exceeded');
  }
}

// Periodic cleanup of rate limit store (every hour)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key] of rateLimitStore) {
    const windowTime = parseInt(key.split(':')[1]) * RATE_LIMIT_WINDOW;
    if (now - windowTime > RATE_LIMIT_WINDOW * 2) {
      rateLimitStore.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[RATE_LIMIT] Cleaned ${cleaned} expired entries`);
  }
}, 3600000);

// Initialize database
let dbReady = false;
let userDataPath = null;
let clientsBaseFolder = null;
let setupRequired = false;
let backupScheduler = null;
let migrationManager = null;
let collateralManager = null;

function initializeDatabase() {
  // Check if setup has been completed
  if (!config.hasCompletedSetup()) {
    // Check for old data migration
    const setupStatus = config.migrateFromOldLocation();
    if (setupStatus.needsMigration && setupStatus.hasDatabase) {
      setupRequired = true;
      console.log('[MAIN] Old data found, migration required');
      return;
    }
    
    // First-time setup
    setupRequired = true;
    console.log('[MAIN] First-time setup required');
    return;
  }
  
  // Setup complete or not needed, proceed with normal init
  userDataPath = path.join(config.getDataDirectory(), 'data');
  clientsBaseFolder = path.join(config.getDataDirectory(), 'ClientFiles');
  
  if (!fs.existsSync(clientsBaseFolder)) {
    fs.mkdirSync(clientsBaseFolder, { recursive: true });
  }
  
  db.init(config.getDataDirectory()).then(() => {
    dbReady = true;
    config.updateLastLaunch();
    handleVersionReset();
    // Apply auto-penalties on startup
    try {
      db.applyAutoPenalties();
    } catch (err) {
      console.error('Auto-penalty error on startup:', err);
    }
    // Run batch assessment for overdue loans (Loan Engine v2.3.0)
    try {
      const result = db.runBatchAssessment();
      console.log('[LoanEngine] Batch assessment on startup:', result);
    } catch (err) {
      console.error('[LoanEngine] Batch assessment error on startup:', err);
    }
  }).catch(err => console.error('DB Init Error:', err));
}

async function ensureDbReady() {
  if (dbReady) return;
  try {
    if (!userDataPath) {
      userDataPath = path.join(config.getDataDirectory(), 'data');
      clientsBaseFolder = path.join(config.getDataDirectory(), 'ClientFiles');
      if (!fs.existsSync(clientsBaseFolder)) {
        fs.mkdirSync(clientsBaseFolder, { recursive: true });
      }
    }
    await db.init(config.getDataDirectory());
    dbReady = true;
    config.updateLastLaunch();
    await handleVersionReset();
    // Apply auto-penalties after DB is ready
    try {
      db.applyAutoPenalties();
    } catch (err) {
      console.error('Auto-penalty error:', err);
    }
    // Run batch assessment for overdue loans (Loan Engine v2.3.0)
    try {
      const result = db.runBatchAssessment();
      console.log('[LoanEngine] Batch assessment:', result);
    } catch (err) {
      console.error('[LoanEngine] Batch assessment error:', err);
    }
  } catch (err) {
    console.error('DB ensureDbReady error:', err);
    throw err;
  }
}

async function handleVersionReset() {
  try {
    const storedVersion = db.getSettingByKey('app_version');
    const resetFlag = db.getSettingByKey('reset_on_version_change');
    const shouldReset = resetFlag === null ? true : (resetFlag === '1' || isDev);

    if (!storedVersion) {
      db.setSetting('app_version', APP_VERSION);
      if (resetFlag === null) db.setSetting('reset_on_version_change', '1');
      return;
    }

    if (storedVersion !== APP_VERSION && shouldReset) {
      console.log('[MAIN] App version changed. Resetting local data for a clean start.');
      await db.resetDatabase();
      db.setSetting('app_version', APP_VERSION);
      db.setSetting('reset_on_version_change', shouldReset ? '1' : '0');
    }
  } catch (err) {
    console.error('handleVersionReset error:', err);
  }
}

// Folder Management Functions
function createClientFolder(clientNumber, clientName) {
  const sanitizedName = clientName.replace(/[^a-z0-9]/gi, '_');
  const clientFolder = path.join(clientsBaseFolder, `${clientNumber}_${sanitizedName}`);
  
  if (!fs.existsSync(clientFolder)) {
    fs.mkdirSync(clientFolder, { recursive: true });
    // Loan documents
    fs.mkdirSync(path.join(clientFolder, 'loans', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(clientFolder, 'loans', 'cleared'), { recursive: true });
    fs.mkdirSync(path.join(clientFolder, 'loans', 'agreements'), { recursive: true });
    // Collateral files
    fs.mkdirSync(path.join(clientFolder, 'collateral', 'images'), { recursive: true });
    fs.mkdirSync(path.join(clientFolder, 'collateral', 'documents'), { recursive: true });
    // Client documents
    fs.mkdirSync(path.join(clientFolder, 'documents', 'identity'), { recursive: true });
    fs.mkdirSync(path.join(clientFolder, 'documents', 'business'), { recursive: true });
    fs.mkdirSync(path.join(clientFolder, 'documents', 'other'), { recursive: true });
    // Signatures
    fs.mkdirSync(path.join(clientFolder, 'signatures'), { recursive: true });
    // Profile
    fs.mkdirSync(path.join(clientFolder, 'profile'), { recursive: true });
  }
  
  return clientFolder;
}

/**
 * Ensure all client folder substructure exists (for migrating older folders)
 */
function ensureClientFolderStructure(clientFolder) {
  const subfolders = [
    'loans/pending',
    'loans/cleared',
    'loans/agreements',
    'collateral/images',
    'collateral/documents',
    'documents/identity',
    'documents/business',
    'documents/other',
    'signatures',
    'profile'
  ];
  
  for (const sub of subfolders) {
    const subPath = path.join(clientFolder, sub);
    if (!fs.existsSync(subPath)) {
      fs.mkdirSync(subPath, { recursive: true });
    }
  }
}

function getClientFolder(clientNumber, clientName) {
  const sanitizedName = clientName.replace(/[^a-z0-9]/gi, '_');
  return path.join(clientsBaseFolder, `${clientNumber}_${sanitizedName}`);
}

function moveLoanFile(clientNumber, clientName, loanNumber, fromStatus, toStatus) {
  try {
    const clientFolder = getClientFolder(clientNumber, clientName);
    const fromFolder = path.join(clientFolder, 'loans', fromStatus);
    const toFolder = path.join(clientFolder, 'loans', toStatus);
    const fileName = `${loanNumber}.pdf`;
    
    const fromPath = path.join(fromFolder, fileName);
    const toPath = path.join(toFolder, fileName);
    
    if (fs.existsSync(fromPath)) {
      fs.renameSync(fromPath, toPath);
      return { success: true };
    }
    return { success: false, error: 'File not found' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Start backup scheduler
function startBackupScheduler() {
  try {
    if (backupScheduler) {
      console.log('[BACKUP_SCHEDULER] Already initialized');
      return;
    }
    
    backupScheduler = new BackupScheduler(db);
    backupScheduler.start();
    console.log('[BACKUP_SCHEDULER] Initialized and started');
  } catch (err) {
    console.error('[BACKUP_SCHEDULER] Failed to start:', err.message);
  }
}

// Initialize migration manager
function initMigrationManager() {
  try {
    if (migrationManager) {
      console.log('[MIGRATION_MANAGER] Already initialized');
      return;
    }
    
    migrationManager = new MigrationManager();
    console.log('[MIGRATION_MANAGER] Initialized');
  } catch (err) {
    console.error('[MIGRATION_MANAGER] Failed to initialize:', err.message);
  }
}

// Initialize collateral manager
function initCollateralManager() {
  try {
    if (collateralManager) {
      console.log('[COLLATERAL_MANAGER] Already initialized');
      return;
    }
    
    collateralManager = new CollateralManager();
    console.log('[COLLATERAL_MANAGER] Initialized');
  } catch (err) {
    console.error('[COLLATERAL_MANAGER] Failed to initialize:', err.message);
  }
}

// Shared helper for creating loans and persisting summary files
async function createLoanAndPersist(payload) {
  console.log('[DEBUG] createLoanAndPersist called with:', JSON.stringify(payload));
  await ensureDbReady();
  try {
    const safeClientId = Number.parseInt(payload.clientId, 10);
    const loanData = {
      clientId: Number.isFinite(safeClientId) ? safeClientId : null,
      amount: Number(payload.amount || 0),
      interest: Number(payload.interest || 0),
      loanDate: payload.loanDate || new Date().toISOString().split('T')[0],
      dueDate: payload.dueDate || new Date().toISOString().split('T')[0],
      status: (payload.status || 'pending'),
      notes: payload.notes || null,
      collateral: payload.collateral || null,
      collateralValue: Number(payload.collateralValue || 0),
      collateralApplicable: payload.collateralApplicable ? 1 : 0
    };
    console.log('[DEBUG] createLoanAndPersist - calling db.addLoan with:', JSON.stringify(loanData));
    const res = db.addLoan(loanData);
    console.log('[DEBUG] createLoanAndPersist - db.addLoan result:', res);

  // Persist lightweight loan summary into the client folder for traceability
  try {
    if (Number.isFinite(safeClientId)) {
      const clientRes = db.exec(`SELECT clientNumber, name FROM clients WHERE id = ?`, [safeClientId]);
    if (clientRes[0]?.values[0]) {
      const clientNumber = clientRes[0].values[0][0];
      const clientName = clientRes[0].values[0][1];
      const loanSummary = {
        loanNumber: res.loanNumber,
        clientNumber,
        clientName,
        amount: loanData.amount,
        interest: loanData.interest,
        loanDate: loanData.loanDate,
        dueDate: loanData.dueDate,
        status: loanData.status,
        createdAt: new Date().toISOString()
      };
      const loanJson = JSON.stringify(loanSummary, null, 2);
      const loansFolder = path.join(getClientFolder(clientNumber, clientName), 'loans', 'pending');
      if (!fs.existsSync(loansFolder)) fs.mkdirSync(loansFolder, { recursive: true });
      fs.writeFileSync(path.join(loansFolder, `${res.loanNumber}_info.json`), loanJson);
    }
    }
  } catch (err) {
    console.error('[WARN] Error saving loan to folder:', err);
  }
  
    // Sync client aggregate data after loan creation
    try {
      if (Number.isFinite(safeClientId)) {
        db.syncClientLoanData(safeClientId);
      }
    } catch (syncErr) {
      console.error('[WARN] Error syncing client data after loan creation:', syncErr);
    }
    
    console.log('[DEBUG] createLoanAndPersist - returning:', res);
    return res;
  } catch (dbErr) {
    console.error('[ERROR] createLoanAndPersist db error:', dbErr);
    throw dbErr;
  }
}

let mainWindow;
let setupWindow = null;
let isSetupMode = false;

function createSetupWindow() {
  if (setupWindow) return;
  
  isSetupMode = true;
  setupWindow = new BrowserWindow({
    width: 600,
    height: 500,
    minWidth: 500,
    minHeight: 400,
    modal: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      sandbox: false, // Temporarily disabled for debugging
    },
    icon: path.join(__dirname, 'logo/MIG-LOGO-LB.png'),
  });

  setupWindow.loadFile(path.join(__dirname, 'index.html'));
  setupWindow.once('ready-to-show', () => {
    setupWindow.webContents.send('setup:show');
    setupWindow.show();
  });

  setupWindow.on('closed', () => {
    setupWindow = null;
    // If setup was not completed, quit app
    if (isSetupMode && !config.hasCompletedSetup()) {
      app.quit();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      sandbox: false, // Temporarily disabled for debugging
    },
    icon: path.join(__dirname, 'logo/MIG-LOGO-LB.png'),
  });

  const startUrl = isDev
    ? 'http://localhost:3000'
    : `file://${path.join(__dirname, '../build/index.html')}`;

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open DevTools in development
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Allow window.open for print windows
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Allow blank windows for printing
    if (url === 'about:blank' || url === '') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 900,
          height: 700,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false
          }
        }
      };
    }
    // Block external URLs
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('ready', () => {
  initializeDatabase();
  
  if (setupRequired) {
    createSetupWindow();
  } else {
    isSetupMode = false;
    createWindow();
    // Start backup scheduler after main window
    startBackupScheduler();
    initMigrationManager();
    initCollateralManager();
  }
});
// Handle setup completion signal from renderer
ipcMain.on('setup:complete', (event) => {
  try {
    console.log('[MAIN] Setup completed, transitioning to main window');
    if (setupWindow) {
      setupWindow.close();
      setupWindow = null;
    }
    isSetupMode = false;
    setupRequired = false;
    // Create main window after setup
    setTimeout(() => {
      if (!mainWindow) {
        createWindow();
      }
      // Start backup scheduler after setup
      startBackupScheduler();
    }, 1000);
  } catch (err) {
    console.error('Error handling setup:complete:', err);
  }
});

// Handle system requests (e.g., open folder)
ipcMain.on('system:openFolder', (event, args) => {
  try {
    const { path: folderPath } = args;
    if (!folderPath) {
      console.error('No path provided');
      return;
    }
    
    // Validate path exists
    if (!fs.existsSync(folderPath)) {
      console.error('Folder does not exist:', folderPath);
      return;
    }
    
    // Open folder in file explorer (platform-specific)
    const { shell } = require('electron');
    shell.openPath(folderPath);
  } catch (err) {
    console.error('Error opening folder:', err);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// Menu
const template = [
  {
    label: 'File',
    submenu: [
      {
        label: 'Exit',
        accelerator: 'CmdOrCtrl+Q',
        click: () => {
          app.quit();
        },
      },
    ],
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
    ],
  },
  {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  },
  {
    label: 'Help',
    submenu: [
      {
        label: 'About',
        click: () => {
          // You can create an about dialog here
        },
      },
    ],
  },
];

const menu = Menu.buildFromTemplate(template);
Menu.setApplicationMenu(menu);

// IPC Handlers for common operations
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-app-path', () => {
  return app.getAppPath();
});

ipcMain.handle('db:health', async () => {
  try {
    await ensureDbReady();
    return { ready: dbReady, path: db.getDbPath ? db.getDbPath() : null };
  } catch (err) {
    return { ready: false, error: err.message };
  }
});

// Reset handlers
ipcMain.handle('db:factoryReset', async () => {
  try {
    await ensureDbReady();
    return db.factoryReset();
  } catch (err) {
    console.error('db:factoryReset error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('settings:reset', async () => {
  try {
    await ensureDbReady();
    return db.resetSettings();
  } catch (err) {
    console.error('settings:reset error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('app:restart', () => {
  app.relaunch();
  app.exit(0);
});

// ===== SHELL: OPEN EXTERNAL URL (WhatsApp, Email, SMS) =====
ipcMain.handle('shell:openExternal', validateIPC({ name: 'shell:openExternal', maxArgsLength: 1, argTypes: ['string'] })(async (event, url) => {
  try {
    // Only allow safe URI schemes
    const allowed = ['https:', 'http:', 'mailto:', 'sms:', 'tel:'];
    let parsed;
    try { parsed = new URL(url); } catch { return { success: false, error: 'Invalid URL' }; }
    if (!allowed.includes(parsed.protocol)) {
      return { success: false, error: 'URI scheme not permitted' };
    }
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    console.error('[shell:openExternal]', err);
    return { success: false, error: err.message };
  }
}));

  // ===== AUTH (HARDENED) =====
  ipcMain.handle('auth:get', async () => {
    try { 
      checkRateLimit('auth:get');
      await ensureDbReady(); 
      return db.getUser(); 
    }
    catch (err) { console.error('auth:get', err); return null; }
  });
  
  ipcMain.handle('auth:register', validateIPC({ name: 'auth:register', maxArgsLength: 1 })(async (event, payload) => {
    try { 
      checkRateLimit('auth:register');
      await ensureDbReady(); 
      if (!payload || !payload.username || !payload.password) {
        throw new Error('Missing required fields');
      }
      return db.registerUser(payload); 
    }
    catch (err) { console.error('auth:register', err); return { success: false, error: err.message }; }
  }));
  
  ipcMain.handle('auth:login', validateIPC({ name: 'auth:login', maxArgsLength: 2, argTypes: ['string', 'string'] })(async (event, username, password) => {
    try { 
      checkRateLimit('auth:login');
      await ensureDbReady(); 
      if (!username || !password) throw new Error('Missing credentials');
      const result = await db.loginUser(username, password);
      // Set current user for authorization checks
      if (result.success && result.user) {
        setCurrentUser(result.user.id, result.user.role || 'user');
        setSession(result.user.id, result.user);
      }
      return result; 
    }
    catch (err) { console.error('auth:login', err); return { success: false, error: err.message }; }
  }));
  
  // Logout handler to clear session
  ipcMain.handle('auth:logout', async () => {
    try {
      const user = getCurrentUser();
      if (user.id) {
        clearSession(user.id);
        db.logAudit('LOGOUT', 'user', user.id, null, null);
      }
      setCurrentUser(null, null);
      return { success: true };
    } catch (err) {
      console.error('auth:logout', err);
      return { success: false, error: err.message };
    }
  });
  
  ipcMain.handle('auth:recover', validateIPC({ name: 'auth:recover', maxArgsLength: 3, argTypes: ['string', 'string', 'string'] })(async (event, username, answer, newPassword) => {
    try { 
      checkRateLimit('auth:recover');
      await ensureDbReady(); 
      return db.recoverUser(username, answer, newPassword); 
    }
    catch (err) { console.error('auth:recover', err); return { success: false, error: err.message }; }
  }));
  
  ipcMain.handle('auth:changePassword', validateIPC({ name: 'auth:changePassword', maxArgsLength: 3, argTypes: ['string', 'string', 'string'] })(async (event, username, currentPassword, newPassword) => {
    try { 
      checkRateLimit('auth:changePassword');
      await ensureDbReady(); 
      return db.changePassword(username, currentPassword, newPassword); 
    }
    catch (err) { console.error('auth:changePassword', err); return { success: false, error: err.message }; }
  }));
  
  ipcMain.handle('auth:getAllUsers', requireAuth(async () => {
    try { 
      await ensureDbReady(); 
      return { success: true, users: db.getAllUsers() }; 
    }
    catch (err) { console.error('auth:getAllUsers', err); return { success: false, error: err.message }; }
  }));
  
  // SECURITY: Admin-only privilege escalation handlers
  ipcMain.handle('auth:updateUserRole', validateIPC({ name: 'auth:updateUserRole', maxArgsLength: 3 })(requireAdmin(async (event, userId, role, permissions) => {
    try { 
      checkRateLimit('auth:updateUserRole');
      await ensureDbReady();
      // Prevent self-demotion (admin cannot remove their own admin role)
      const currentUser = getCurrentUser();
      if (currentUser.id === userId && role !== 'admin') {
        return { success: false, error: 'Cannot remove your own admin privileges' };
      }
      db.logAudit('ROLE_CHANGE_ATTEMPT', 'user', userId, `by:${currentUser.id}`, `${role}:${permissions}`);
      return db.updateUserRole(userId, role, permissions); 
    }
    catch (err) { console.error('auth:updateUserRole', err); return { success: false, error: err.message }; }
  })));
  
  ipcMain.handle('auth:toggleUserStatus', validateIPC({ name: 'auth:toggleUserStatus', maxArgsLength: 2 })(requireAdmin(async (event, userId, isActive) => {
    try { 
      checkRateLimit('auth:toggleUserStatus');
      await ensureDbReady();
      // Prevent self-deactivation
      const currentUser = getCurrentUser();
      if (currentUser.id === userId && !isActive) {
        return { success: false, error: 'Cannot deactivate your own account' };
      }
      db.logAudit('STATUS_CHANGE_ATTEMPT', 'user', userId, `by:${currentUser.id}`, isActive ? 'ACTIVE' : 'INACTIVE');
      return db.toggleUserStatus(userId, isActive); 
    }
    catch (err) { console.error('auth:toggleUserStatus', err); return { success: false, error: err.message }; }
  })));
  
  ipcMain.handle('auth:deleteUser', validateIPC({ name: 'auth:deleteUser', maxArgsLength: 1 })(requireAdmin(async (event, userId) => {
    try { 
      checkRateLimit('auth:deleteUser');
      await ensureDbReady();
      // Prevent self-deletion
      const currentUser = getCurrentUser();
      if (currentUser.id === userId) {
        return { success: false, error: 'Cannot delete your own account' };
      }
      db.logAudit('DELETE_USER_ATTEMPT', 'user', userId, `by:${currentUser.id}`, null);
      return db.deleteUser(userId); 
    }
    catch (err) { console.error('auth:deleteUser', err); return { success: false, error: err.message }; }
  })));
  
  // SECURITY: Only allow resetDevData in development mode or by admin with confirmation
  ipcMain.handle('system:resetDevData', requireAdmin(async () => {
    try {
      // Block in production unless explicitly enabled
      if (PRODUCTION_MODE) {
        console.warn('[SECURITY] Database reset blocked in production mode');
        return { success: false, error: 'Database reset is disabled in production mode' };
      }
      await ensureDbReady();
      db.logAudit('DATABASE_RESET', 'system', 0, null, 'FULL_RESET');
      await db.resetDatabase();
      return { success: true };
    }
    catch (err) { console.error('system:resetDevData', err); return { success: false, error: err.message }; }
  }));

  // ===== CONFIGURATION HANDLERS =====
  ipcMain.handle('config:getDataDirectory', async () => {
    try {
      return { success: true, dataDirectory: config.getDataDirectory() };
    } catch (err) {
      console.error('config:getDataDirectory', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('config:selectDataDirectory', async (event) => {
    try {
      const result = await dialog.showOpenDialog(mainWindow || setupWindow, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select Data Storage Location',
        message: 'Choose where you want to store your MIGL data',
        defaultPath: config.getDataDirectory()
      });

      if (result.canceled || !result.filePaths[0]) {
        return { success: false, error: 'Selection canceled' };
      }

      const selectedPath = result.filePaths[0];
      const currentDataDir = config.getDataDirectory();
      
      // Check if changing from existing location (migration)
      if (dbReady && currentDataDir !== selectedPath) {
        // Migrate data from current to new location
        console.log('[MAIN] Migrating data from', currentDataDir, 'to', selectedPath);
        const migrationResult = config.migrateDataDirectory(currentDataDir, selectedPath);
        
        if (migrationResult.success) {
          // Reinitialize database with new path
          userDataPath = path.join(selectedPath, 'data');
          clientsBaseFolder = path.join(selectedPath, 'ClientFiles');
          // Note: db might need to be reinitialized depending on implementation
          return { success: true, dataDirectory: selectedPath, migrated: true };
        } else {
          return { success: false, error: 'Migration failed: ' + migrationResult.error };
        }
      } else if (setupRequired && !dbReady) {
        // First-time setup scenario
        const setResult = config.setDataDirectory(selectedPath);
        if (setResult.success) {
          userDataPath = path.join(selectedPath, 'data');
          clientsBaseFolder = path.join(selectedPath, 'ClientFiles');
          await db.init(selectedPath);
          dbReady = true;
          await handleVersionReset();
          setupRequired = false;
          isSetupMode = false;
          return { success: true, dataDirectory: selectedPath };
        } else {
          return { success: false, error: setResult.error };
        }
      } else {
        // No DB ready yet, just set the directory
        const setResult = config.setDataDirectory(selectedPath);
        return setResult.success 
          ? { success: true, dataDirectory: selectedPath }
          : { success: false, error: setResult.error };
      }
    } catch (err) {
      console.error('config:selectDataDirectory', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('config:hasCompletedSetup', async () => {
    try {
      return { success: true, completed: config.hasCompletedSetup() };
    } catch (err) {
      console.error('config:hasCompletedSetup', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('config:checkMigration', async () => {
    try {
      const migrationStatus = config.migrateFromOldLocation();
      return { success: true, ...migrationStatus };
    } catch (err) {
      console.error('config:checkMigration', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('config:migrateData', async (event, fromDir, toDir) => {
    try {
      const result = config.migrateDataDirectory(fromDir, toDir);
      
      if (result.success) {
        // Reinitialize database with new path
        userDataPath = path.join(toDir, 'data');
        clientsBaseFolder = path.join(toDir, 'ClientFiles');
        await db.init(toDir);
        dbReady = true;
        await handleVersionReset();
      }
      
      return result;
    } catch (err) {
      console.error('config:migrateData', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('config:completeSetup', async (event) => {
    try {
      // Mark setup as completed without changing directory
      const cfg = config.readConfig();
      cfg.hasCompletedSetup = true;
      cfg.setupDate = new Date().toISOString();
      config.writeConfig(cfg);
      
      return { success: true };
    } catch (err) {
      console.error('config:completeSetup', err);
      return { success: false, error: err.message };
    }
  });

  // ===== LICENSING HANDLERS =====
  ipcMain.handle('license:getMachineId', async () => {
    try {
      await ensureDbReady();
      return { success: true, machineId: db.getMachineId() };
    } catch (err) {
      console.error('license:getMachineId', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('license:validate', async (event, licenseKey) => {
    try {
      await ensureDbReady();
      const machineId = db.getMachineId();
      let result;
      // Support both v1 (MIG-) and v2 (MIG2-ECDSA) license formats
      if (licenseKey && licenseKey.startsWith('MIG2-')) {
        result = licenseValidatorV2.validateLicense(licenseKey, machineId);
      } else {
        result = db.validateLicense(licenseKey);
        // Derive licenseType for v1 keys from embedded markers
        if (!result.licenseType) {
          if ((licenseKey || '').includes('STR')) result.licenseType = 'starter';
          else if ((licenseKey || '').includes('PRO')) result.licenseType = 'professional';
          else if ((licenseKey || '').includes('BIZ')) result.licenseType = 'business';
          else result.licenseType = 'standard';
        }
      }
      if (result.valid) {
        db.setSetting('license_key', licenseKey);
        db.setSetting('license_status', 'active');
        db.setSetting('license_expiry', result.expiryDate || '');
        db.setSetting('license_type', result.licenseType || 'standard');
        db.logAudit('LICENSE_ACTIVATED', 'system', 0, null, JSON.stringify({ type: result.licenseType }));
      }
      return { success: true, ...result };
    } catch (err) {
      console.error('license:validate', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('license:getStatus', async () => {
    try {
      await ensureDbReady();
      const licenseKey = db.getSettingByKey('license_key');
      if (!licenseKey) {
        return { success: true, status: 'inactive', valid: false, message: 'No license activated', licenseType: null };
      }
      const machineId = db.getMachineId();
      let result;
      if (licenseKey.startsWith('MIG2-')) {
        result = licenseValidatorV2.validateLicense(licenseKey, machineId);
      } else {
        result = db.validateLicense(licenseKey);
        if (!result.licenseType) {
          if (licenseKey.includes('STR')) result.licenseType = 'starter';
          else if (licenseKey.includes('PRO')) result.licenseType = 'professional';
          else if (licenseKey.includes('BIZ')) result.licenseType = 'business';
          else result.licenseType = 'standard';
        }
      }
      if (result.valid && result.licenseType) {
        db.setSetting('license_type', result.licenseType);
      }
      return { success: true, ...result };
    } catch (err) {
      console.error('license:getStatus', err);
      return { success: false, error: err.message };
    }
  });

  // Dev helper: generate a valid license for current machine
  ipcMain.handle('license:generateTest', async (event, days) => {
    try {
      await ensureDbReady();
      const res = db.generateTestLicense(days || 30);
      return { success: !res.error, ...res };
    } catch (err) {
      console.error('license:generateTest', err);
      return { success: false, error: err.message };
    }
  });

  // License tier checking
  ipcMain.handle('license:getTier', async () => {
    try {
      await ensureDbReady();
      let tier = db.getLicenseTier();
      // For v2 keys, override with validated licenseType → tier mapping
      const licenseKey = db.getSettingByKey('license_key');
      if (licenseKey && licenseKey.startsWith('MIG2-')) {
        const machineId = db.getMachineId();
        const v2 = licenseValidatorV2.validateLicense(licenseKey, machineId);
        if (v2.valid) {
          const typeToTier = { trial: 'trial', personal: 'starter', professional: 'pro', enterprise: 'business' };
          tier = typeToTier[v2.licenseType] || 'starter';
        } else {
          tier = 'expired';
        }
      }
      const limits = db.getTierLimits(tier);
      return { success: true, tier, limits };
    } catch (err) {
      console.error('license:getTier', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('license:checkLimit', async (event, entityType) => {
    try {
      await ensureDbReady();
      return { success: true, ...db.checkTierLimit(entityType) };
    } catch (err) {
      console.error('license:checkLimit', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('license:canUseFeature', async (event, feature) => {
    try {
      await ensureDbReady();
      return { success: true, allowed: db.canUseFeature(feature) };
    } catch (err) {
      console.error('license:canUseFeature', err);
      return { success: false, error: err.message };
    }
  });

  // ===== SYSTEM DIAGNOSTICS & SUPPORT IPC HANDLERS =====

  ipcMain.handle('system:getDiagnostics', async () => {
    try {
      const os = require('os');
      await ensureDbReady();

      // DB file info
      let dbSize = 0, dbPath = '';
      try {
        dbPath = db.getDbPath ? db.getDbPath() : '';
        if (dbPath && fs.existsSync(dbPath)) {
          dbSize = fs.statSync(dbPath).size;
        }
      } catch (e) { /* ignore */ }

      // Data directory disk usage
      let dataDir = '';
      try {
        dataDir = config.getDataDirectory ? config.getDataDirectory() : '';
      } catch (e) { /* ignore */ }

      // Backup info
      let backupInfo = { count: 0, lastBackup: null };
      try {
        const backupDir = path.join(dataDir || __dirname, 'data', 'backups');
        if (fs.existsSync(backupDir)) {
          const backups = fs.readdirSync(backupDir).filter(f => f.endsWith('.db'));
          backupInfo.count = backups.length;
          if (backups.length > 0) {
            const stats = backups.map(f => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtime }));
            stats.sort((a, b) => b.mtime - a.mtime);
            backupInfo.lastBackup = stats[0].mtime.toISOString();
            backupInfo.lastBackupName = stats[0].name;
          }
        }
      } catch (e) { /* ignore */ }

      // Recent error count from today's log
      let recentErrors = 0;
      try {
        const logDir = path.join(dataDir || __dirname, 'data', 'logs');
        const today = new Date().toISOString().split('T')[0];
        const logFile = path.join(logDir, `app-${today}.log`);
        if (fs.existsSync(logFile)) {
          const content = fs.readFileSync(logFile, 'utf-8');
          recentErrors = (content.match(/\[ERROR\]/gi) || []).length;
        }
      } catch (e) { /* ignore */ }

      // License status (pass stored key — calling without arg always returns invalid)
      let licenseStatus = {};
      try {
        const storedKey = db.getSettingByKey('license_key');
        if (storedKey) {
          const mid = db.getMachineId();
          licenseStatus = storedKey.startsWith('MIG2-')
            ? licenseValidatorV2.validateLicense(storedKey, mid)
            : db.validateLicense(storedKey);
          if (!licenseStatus.licenseType) {
            if (storedKey.includes('STR')) licenseStatus.licenseType = 'starter';
            else if (storedKey.includes('PRO')) licenseStatus.licenseType = 'professional';
            else if (storedKey.includes('BIZ')) licenseStatus.licenseType = 'business';
            else licenseStatus.licenseType = 'standard';
          }
        }
      } catch (e) { /* ignore */ }

      // DB table counts
      let tableStats = {};
      try {
        const tables = ['clients', 'loans', 'payments', 'penalties', 'expenses', 'collateral', 'audit_log'];
        for (const t of tables) {
          try {
            const row = db.getDb().prepare(`SELECT COUNT(*) as cnt FROM ${t}`).getAsObject();
            tableStats[t] = row.cnt;
          } catch (e) { /* table may not exist */ }
        }
      } catch (e) { /* ignore */ }

      return {
        success: true,
        system: {
          platform: os.platform(),
          release: os.release(),
          arch: os.arch(),
          hostname: os.hostname(),
          cpuCount: os.cpus().length,
          cpuModel: os.cpus()[0]?.model || 'Unknown',
          totalMemory: os.totalmem(),
          freeMemory: os.freemem(),
          uptime: os.uptime()
        },
        app: {
          version: APP_VERSION,
          electronVersion: process.versions.electron,
          nodeVersion: process.versions.node,
          chromeVersion: process.versions.chrome,
          appUptime: process.uptime(),
          pid: process.pid,
          isDev: isDev
        },
        database: {
          path: dbPath,
          size: dbSize,
          tableStats: tableStats,
          healthy: dbReady
        },
        license: {
          valid: licenseStatus.valid || false,
          type: licenseStatus.licenseType || 'none',
          expiry: licenseStatus.expiryDate || null,
          daysRemaining: licenseStatus.daysRemaining != null ? licenseStatus.daysRemaining : null
        },
        backup: backupInfo,
        dataDirectory: dataDir,
        recentErrors: recentErrors
      };
    } catch (err) {
      console.error('system:getDiagnostics', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('system:getRecentLogs', async (event, count = 100, level = null) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      let content = '';

      // Check logger.js location first (project/logs/app-YYYY-MM-DD.log)
      const appLogFile = path.join(__dirname, 'logs', `app-${today}.log`);
      if (fs.existsSync(appLogFile)) {
        content = fs.readFileSync(appLogFile, 'utf-8');
      } else {
        // Fallback: check data directory logs
        const dataDir = config.getDataDirectory ? config.getDataDirectory() : __dirname;
        const prodLogFile = path.join(dataDir, 'data', 'logs', 'migl-production.log');
        if (fs.existsSync(prodLogFile)) {
          content = fs.readFileSync(prodLogFile, 'utf-8');
        }
      }

      if (!content) {
        return { success: true, logs: [], message: 'No log files found' };
      }

      let lines = content.split('\n').filter(l => l.trim());

      // Parse log lines (support both formats)
      let entries = lines.map(line => {
        // Format 1: [timestamp] [LEVEL] message (from logger.js)
        const match = line.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.*)/);
        if (match) {
          return { timestamp: match[1], level: match[2].trim().toUpperCase(), message: match[3] };
        }
        // Format 2: JSON logs (from production db logger)
        try {
          const j = JSON.parse(line);
          return { timestamp: j.timestamp || '', level: (j.level || j.action || 'INFO').toUpperCase(), message: j.message || j.action || line };
        } catch {}
        return { timestamp: '', level: 'INFO', message: line };
      });

      // Filter by level if specified
      if (level && level !== 'ALL') {
        entries = entries.filter(e => e.level === level.toUpperCase());
      }

      // Return last N entries
      entries = entries.slice(-count);

      return { success: true, logs: entries };
    } catch (err) {
      console.error('system:getRecentLogs', err);
      return { success: false, error: err.message, logs: [] };
    }
  });

  ipcMain.handle('system:generateSupportReport', async () => {
    try {
      const os = require('os');
      await ensureDbReady();

      const machineId = db.getMachineId ? db.getMachineId() : 'N/A';
      let licenseStatus = {};
      try {
        const storedKey = db.getSettingByKey('license_key');
        if (storedKey) {
          licenseStatus = storedKey.startsWith('MIG2-')
            ? licenseValidatorV2.validateLicense(storedKey, machineId)
            : db.validateLicense(storedKey);
        }
      } catch (e) { /* ignore */ }
      let tierInfo = {};
      try { tierInfo = db.getLicenseTier ? db.getLicenseTier() : {}; } catch (e) { /* ignore */ }

      // Recent errors
      let recentErrors = [];
      try {
        const dataDir = config.getDataDirectory ? config.getDataDirectory() : __dirname;
        const logDir = path.join(dataDir, 'data', 'logs');
        const today = new Date().toISOString().split('T')[0];
        const logFile = path.join(logDir, `app-${today}.log`);
        if (fs.existsSync(logFile)) {
          const content = fs.readFileSync(logFile, 'utf-8');
          const lines = content.split('\n').filter(l => /\[ERROR\]/i.test(l));
          recentErrors = lines.slice(-20);
        }
      } catch (e) { /* ignore */ }

      const report = {
        generatedAt: new Date().toISOString(),
        machineId: machineId,
        app: {
          version: APP_VERSION,
          electron: process.versions.electron,
          node: process.versions.node
        },
        system: {
          os: `${os.platform()} ${os.release()} (${os.arch()})`,
          cpu: `${os.cpus()[0]?.model || 'Unknown'} x${os.cpus().length}`,
          memory: `${Math.round(os.totalmem() / 1073741824 * 10) / 10} GB total, ${Math.round(os.freemem() / 1073741824 * 10) / 10} GB free`
        },
        license: {
          valid: licenseStatus.valid || false,
          type: licenseStatus.licenseType || 'none',
          expiry: licenseStatus.expiryDate || 'N/A',
          tier: tierInfo.tier || 'unknown'
        },
        database: {
          healthy: dbReady,
          path: db.getDbPath ? db.getDbPath() : 'N/A'
        },
        recentErrors: recentErrors
      };

      return { success: true, report: report };
    } catch (err) {
      console.error('system:generateSupportReport', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('docs:getContent', async (event, filename) => {
    try {
      // Whitelist allowed doc files for security
      const allowedDocs = [
        'USER_GUIDE.md', 'QUICK_START.md', 'FEATURES_GUIDE.md',
        'DEPLOYMENT_GUIDE.md', 'CHANGELOG.md', 'API_DOCUMENTATION.md'
      ];
      // Sanitize: use only basename to prevent path traversal
      const safeName = path.basename(filename);
      if (!allowedDocs.includes(safeName)) {
        return { success: false, error: 'Document not available' };
      }
      const docPath = path.join(__dirname, 'DOCUMENTATION', safeName);
      if (!fs.existsSync(docPath)) {
        return { success: false, error: 'Document file not found' };
      }
      const content = fs.readFileSync(docPath, 'utf-8');
      return { success: true, content: content, filename: safeName };
    } catch (err) {
      console.error('docs:getContent', err);
      return { success: false, error: err.message };
    }
  });

ipcMain.handle('export-to-pdf', async (event, htmlContent, filename) => {
  try {
    const fs = require('fs');
    // In production, you'd use jsPDF to convert here
    // For now, just return success
    return { success: true, message: 'PDF exported successfully' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-pdf', async (event, base64, filename) => {
  try{
    const os = require('os');
    const fs = require('fs');
    const desktop = path.join(os.homedir(), 'Desktop');
    const outPath = path.join(desktop, filename || `export-${Date.now()}.pdf`);
    const buf = Buffer.from(base64, 'base64');
    fs.writeFileSync(outPath, buf);
    return { success: true, path: outPath };
  }catch(err){ return { success:false, error: err.message } }
});

// PRINT HANDLER: render provided HTML in a hidden window and invoke print
ipcMain.handle('print:html', async (event, html, title) => {
  try {
    const printWindow = new BrowserWindow({
      width: 900,
      height: 1000,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      }
    });

    const pageHtml = `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>${(title||'Document')}</title><meta http-equiv="Content-Security-Policy" content="default-src 'self' data:; img-src 'self' data: file:; style-src 'unsafe-inline' 'self'; font-src 'self' data:;"/></head><body style="margin:0;background:#fff;">${html}</body></html>`;

    await printWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml));

    return await new Promise((resolve) => {
      printWindow.webContents.on('did-finish-load', () => {
        printWindow.webContents.print({ silent: false, printBackground: true }, (success, failureReason) => {
          try { printWindow.close(); } catch (_) {}
          if (!success) return resolve({ success: false, error: failureReason || 'Print failed' });
          resolve({ success: true });
        });
      });
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- Database IPC handlers (clients & loans) ---
ipcMain.handle('clients:get', async () => {
  await ensureDbReady();
  try { return db.getClients(); } catch (err) { console.error('clients:get', err); return []; }
});

ipcMain.handle('clients:getById', async (event, id) => {
  await ensureDbReady();
  try { return db.getClientById(id); } catch (err) { console.error('clients:getById', err); return null; }
});

ipcMain.handle('clients:save', async (event, payload) => {
  await ensureDbReady();
  try{
    // Build client data object with all extended fields
    const clientData = {
      // Core fields
      name: payload.name,
      phone: payload.phone,
      nrc: payload.nrc,
      email: payload.email,
      notes: payload.notes,
      // Identity fields
      gender: payload.gender || null,
      dateOfBirth: payload.dateOfBirth || null,
      phone2: payload.phone2 || null,
      address: payload.address || null,
      // Employment/Financial
      occupation: payload.occupation || null,
      employer: payload.employer || null,
      monthlyIncome: payload.monthlyIncome || null,
      employmentStatus: payload.employmentStatus || null,
      // Next of Kin
      nokName: payload.nokName || null,
      nokRelation: payload.nokRelation || null,
      nokPhone: payload.nokPhone || null,
      // Risk & Credit
      riskLevel: payload.riskLevel || 'medium',
      creditScore: payload.creditScore || null,
      creditScoreDate: payload.creditScoreDate || null,
      // KYC/Compliance
      kycStatus: payload.kycStatus || 'pending',
      kycDate: payload.kycDate || null,
      kycDocuments: payload.kycDocuments || null,
      kycNotes: payload.kycNotes || null,
      blacklistStatus: payload.blacklistStatus || 'clear',
      blacklistReason: payload.blacklistReason || null,
      blacklistDate: payload.blacklistDate || null,
      // Status & Stats (usually computed, but allow manual override)
      status: payload.status || 'active',
      // Profile & Preferences
      profileImage: payload.profileImage || null,
      tags: payload.tags || null,
      preferredContact: payload.preferredContact || 'phone',
      preferredLanguage: payload.preferredLanguage || 'en',
      // Organization
      branchCode: payload.branchCode || null,
      assignedOfficer: payload.assignedOfficer || null,
      referredBy: payload.referredBy || null,
      groupId: payload.groupId || null
    };
    
    if(payload.id){
      const res = db.updateClient(payload.id, clientData);
      return { success: true, changes: res.changes };
    } else {
      const res = db.addClient(clientData);
      // Auto-create client folder
      if (res.clientNumber) {
        createClientFolder(res.clientNumber, payload.name);
      }
      return { success: true, id: res.id, clientNumber: res.clientNumber };
    }
  }catch(err){ return { success:false, error: err.message } }
});

// Client risk calculation
ipcMain.handle('clients:calculateRisk', async (event, clientId) => {
  await ensureDbReady();
  try {
    // Get client and their loan history
    const client = db.getClientById(clientId);
    if (!client) return { success: false, error: 'Client not found' };
    
    const loans = db.getLoansByClient(clientId);
    const payments = db.getPaymentsByClient ? db.getPaymentsByClient(clientId) : [];
    
    // Risk scoring algorithm
    let riskScore = 50; // Start neutral
    
    // Factor 1: Payment history (-20 to +20)
    if (loans.length > 0) {
      const onTimePayments = payments.filter(p => !p.isLate).length;
      const latePayments = payments.filter(p => p.isLate).length;
      const paymentRatio = payments.length > 0 ? onTimePayments / payments.length : 0.5;
      riskScore += (paymentRatio * 40) - 20;
    }
    
    // Factor 2: Loan completion rate (-15 to +15)
    const completedLoans = loans.filter(l => l.status === 'cleared' || l.status === 'completed').length;
    const completionRate = loans.length > 0 ? completedLoans / loans.length : 0;
    riskScore += (completionRate * 30) - 15;
    
    // Factor 3: Employment status (-10 to +10)
    if (client.employmentStatus === 'employed') riskScore += 10;
    else if (client.employmentStatus === 'self-employed') riskScore += 5;
    else if (client.employmentStatus === 'unemployed') riskScore -= 10;
    
    // Factor 4: Income level (-5 to +10)
    const income = parseFloat(client.monthlyIncome) || 0;
    if (income >= 10000) riskScore += 10;
    else if (income >= 5000) riskScore += 5;
    else if (income >= 2000) riskScore += 0;
    else riskScore -= 5;
    
    // Factor 5: KYC status (-10 to +5)
    if (client.kycStatus === 'verified') riskScore += 5;
    else if (client.kycStatus === 'pending') riskScore -= 5;
    else if (client.kycStatus === 'rejected') riskScore -= 10;
    
    // Blacklist penalty (-30)
    if (client.blacklistStatus === 'blacklisted') riskScore -= 30;
    
    // Clamp score between 0 and 100
    riskScore = Math.max(0, Math.min(100, Math.round(riskScore)));
    
    // Determine risk level
    let riskLevel;
    if (riskScore >= 75) riskLevel = 'low';
    else if (riskScore >= 50) riskLevel = 'medium';
    else if (riskScore >= 25) riskLevel = 'high';
    else riskLevel = 'critical';
    
    // Update client with new risk score
    db.updateClient(clientId, {
      creditScore: riskScore,
      creditScoreDate: new Date().toISOString(),
      riskLevel: riskLevel
    });
    
    return { 
      success: true, 
      creditScore: riskScore, 
      riskLevel: riskLevel,
      factors: {
        paymentHistory: payments.length,
        completedLoans: completedLoans,
        totalLoans: loans.length,
        employmentStatus: client.employmentStatus,
        income: income,
        kycStatus: client.kycStatus
      }
    };
  } catch (err) { 
    return { success: false, error: err.message };
  }
});

// Get client statistics
ipcMain.handle('clients:getStats', async (event, clientId) => {
  await ensureDbReady();
  try {
    const client = db.getClientById(clientId);
    if (!client) return { success: false, error: 'Client not found' };
    
    const loans = db.getLoansByClient(clientId);
    const activeLoans = loans.filter(l => l.status === 'active' || l.status === 'pending');
    const completedLoans = loans.filter(l => l.status === 'cleared' || l.status === 'completed');
    
    // Calculate lifetime value (total interest paid)
    let lifetimeValue = 0;
    completedLoans.forEach(loan => {
      lifetimeValue += parseFloat(loan.interestPaid || 0);
    });
    
    // Calculate average payment time (days)
    let avgPaymentTime = 0;
    // This would require payment date analysis
    
    return {
      success: true,
      stats: {
        totalLoans: loans.length,
        activeLoans: activeLoans.length,
        completedLoans: completedLoans.length,
        lifetimeValue: lifetimeValue,
        avgPaymentTime: avgPaymentTime,
        firstLoanDate: loans.length > 0 ? loans[loans.length - 1].createdAt : null,
        lastLoanDate: loans.length > 0 ? loans[0].createdAt : null
      }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Update client KYC status
ipcMain.handle('clients:updateKYC', async (event, clientId, kycData) => {
  await ensureDbReady();
  try {
    // Fetch existing client data first
    const existingClient = db.getClientById(clientId);
    if (!existingClient) {
      return { success: false, error: 'Client not found' };
    }
    
    // Merge KYC updates with existing client data
    const updatedClient = {
      ...existingClient,
      kycStatus: kycData.status,
      kycVerifiedDate: new Date().toISOString(),
      kycNotes: kycData.notes || existingClient.kycNotes || null
    };
    
    const res = db.updateClient(clientId, updatedClient);
    db.logAudit('UPDATE_KYC', 'client', clientId, null, JSON.stringify({ kycStatus: kycData.status }));
    
    return { success: true, changes: res.changes };
  } catch (err) {
    console.error('clients:updateKYC error:', err);
    return { success: false, error: err.message };
  }
});

// Update client blacklist status
ipcMain.handle('clients:updateBlacklist', async (event, clientId, blacklistData) => {
  await ensureDbReady();
  try {
    // Fetch existing client data first
    const existingClient = db.getClientById(clientId);
    if (!existingClient) {
      return { success: false, error: 'Client not found' };
    }
    
    // Merge blacklist updates with existing client data
    // DB field is 'blacklisted' (INTEGER), not 'blacklistStatus'
    const updatedClient = {
      ...existingClient,
      blacklisted: blacklistData.status === 'blacklisted' ? 1 : 0
    };
    
    const res = db.updateClient(clientId, updatedClient);
    db.logAudit('UPDATE_BLACKLIST', 'client', clientId, null, JSON.stringify({ blacklisted: updatedClient.blacklisted }));
    
    return { success: true, changes: res.changes };
  } catch (err) {
    console.error('clients:updateBlacklist error:', err);
    return { success: false, error: err.message };
  }
});

// Search clients with advanced filters
ipcMain.handle('clients:search', async (event, filters) => {
  await ensureDbReady();
  try {
    let clients = db.getClients();
    
    // Apply filters
    if (filters.text) {
      const searchText = filters.text.toLowerCase();
      clients = clients.filter(c => 
        (c.name && c.name.toLowerCase().includes(searchText)) ||
        (c.clientNumber && c.clientNumber.toLowerCase().includes(searchText)) ||
        (c.phone && c.phone.includes(searchText)) ||
        (c.nrc && c.nrc.toLowerCase().includes(searchText)) ||
        (c.email && c.email.toLowerCase().includes(searchText))
      );
    }
    
    if (filters.status && filters.status !== 'all') {
      clients = clients.filter(c => c.status === filters.status);
    }
    
    if (filters.riskLevel && filters.riskLevel !== 'all') {
      clients = clients.filter(c => c.riskLevel === filters.riskLevel);
    }
    
    if (filters.kycStatus && filters.kycStatus !== 'all') {
      clients = clients.filter(c => c.kycStatus === filters.kycStatus);
    }
    
    if (filters.hasActiveLoans !== undefined) {
      // Would need to join with loans table
    }
    
    if (filters.branchCode) {
      clients = clients.filter(c => c.branchCode === filters.branchCode);
    }
    
    if (filters.assignedOfficer) {
      clients = clients.filter(c => c.assignedOfficer === filters.assignedOfficer);
    }
    
    // Sort
    if (filters.sortBy) {
      const sortField = filters.sortBy;
      const sortDir = filters.sortDir === 'asc' ? 1 : -1;
      clients.sort((a, b) => {
        if (a[sortField] < b[sortField]) return -1 * sortDir;
        if (a[sortField] > b[sortField]) return 1 * sortDir;
        return 0;
      });
    }
    
    // Pagination
    const page = filters.page || 1;
    const pageSize = filters.pageSize || 50;
    const total = clients.length;
    const start = (page - 1) * pageSize;
    clients = clients.slice(start, start + pageSize);
    
    return {
      success: true,
      clients: clients,
      pagination: {
        page: page,
        pageSize: pageSize,
        total: total,
        totalPages: Math.ceil(total / pageSize)
      }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('clients:delete', async (event, id) => {
  await ensureDbReady();
  try{ const res = db.deleteClient(id); return { success:true, changes: res.changes } }catch(err){ return { success:false, error:err.message } }
});

ipcMain.handle('loans:get', async () => {
  await ensureDbReady();
  try { return db.getLoans(); } catch (err) { console.error('loans:get', err); return []; }
});

ipcMain.handle('loans:add', async (event, payload) => {
  console.log('[IPC] loans:add called with:', JSON.stringify(payload));
  try {
    await ensureDbReady();
    const res = await createLoanAndPersist(payload);
    console.log('[IPC] loans:add result:', res);
    return { success: true, id: res.id, loanNumber: res.loanNumber };
  } catch (err) {
    console.error('[IPC-ERROR] loans:add exception:', err?.message || err);
    return { success: false, error: err?.message || err?.toString() || String(err) };
  }
});

ipcMain.handle('loans:getByClient', async (event, clientId) => {
  await ensureDbReady();
  try { return db.getLoansByClient(clientId); } catch (err) { console.error('loans:getByClient', err); return []; }
});

ipcMain.handle('loans:save', async (event, payload) => {
  console.log('[DEBUG] loans:save called with payload:', JSON.stringify(payload));
  await ensureDbReady();
  try{
    if(payload.id){
      console.log('[DEBUG] loans:save - updating existing loan', payload.id);
      const res = db.updateLoan(payload.id, {
        amount: payload.amount,
        interest: payload.interest,
        loanDate: payload.loanDate,
        dueDate: payload.dueDate,
        status: payload.status,
        notes: payload.notes,
        collateral: payload.collateral,
        collateralValue: payload.collateralValue,
        collateralApplicable: payload.collateralApplicable ? 1 : 0,
        signatureData: payload.signatureData,
        signingDate: payload.signingDate
      });
      return { success:true, changes: res.changes };
    } else {
      console.log('[DEBUG] loans:save - creating new loan via createLoanAndPersist');
      const res = await createLoanAndPersist(payload);
      console.log('[DEBUG] loans:save - createLoanAndPersist result:', res);
      return { success:true, id: res.id, loanNumber: res.loanNumber };
    }
  }catch(err){
    console.error('[ERROR] loans:save exception:', err);
    console.error('[ERROR] loans:save err.toString():', err?.toString());
    console.error('[ERROR] loans:save err.message:', err?.message);
    console.error('[ERROR] loans:save full error:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
    return { success:false, error: err?.message || err?.toString() || String(err) }
  }
});

ipcMain.handle('loans:delete', async (event, id) => {
  await ensureDbReady();
  try{ const res = db.deleteLoan(id); return { success:true, changes: res.changes } }catch(err){ return { success:false, error:err.message } }
});

// Loan details & signature
ipcMain.handle('loans:getDetails', async (event, loanId) => {
  await ensureDbReady();
  try { return db.getLoanDetails(loanId); } catch (err) { console.error('loans:getDetails', err); return null; }
});

ipcMain.handle('loans:saveSignature', async (event, loanId, signatureData) => {
  await ensureDbReady();
  try {
    // Save to database
    const result = db.saveLoanSignature(loanId, signatureData);
    
    // Also save to client folder if available
    try {
      const loan = db.getLoanDetails(loanId);
      if (loan && loan.clientNumber && loan.clientName) {
        const clientFolder = getClientFolder(loan.clientNumber, loan.clientName);
        ensureClientFolderStructure(clientFolder);
        
        const sigFolder = path.join(clientFolder, 'signatures');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        
        // Parse signature data
        let sigData = signatureData;
        if (typeof signatureData === 'string' && signatureData.startsWith('{')) {
          try {
            sigData = JSON.parse(signatureData);
          } catch (e) {}
        }
        
        // Save borrower signature
        if (sigData.borrowerSignature && sigData.borrowerSignature.startsWith('data:image')) {
          const base64Data = sigData.borrowerSignature.replace(/^data:image\/\w+;base64,/, '');
          const sigPath = path.join(sigFolder, `${loan.loanNumber}_borrower_${timestamp}.png`);
          fs.writeFileSync(sigPath, base64Data, 'base64');
        }
        
        // Save lender signature
        if (sigData.lenderSignature && sigData.lenderSignature.startsWith('data:image')) {
          const base64Data = sigData.lenderSignature.replace(/^data:image\/\w+;base64,/, '');
          const sigPath = path.join(sigFolder, `${loan.loanNumber}_lender_${timestamp}.png`);
          fs.writeFileSync(sigPath, base64Data, 'base64');
        }
        
        // Single signature (backward compat)
        if (typeof sigData === 'string' && sigData.startsWith('data:image')) {
          const base64Data = sigData.replace(/^data:image\/\w+;base64,/, '');
          const sigPath = path.join(sigFolder, `${loan.loanNumber}_signature_${timestamp}.png`);
          fs.writeFileSync(sigPath, base64Data, 'base64');
        }
      }
    } catch (fileErr) {
      console.error('Failed to save signature file:', fileErr);
    }
    
    return result;
  } catch (err) {
    console.error('loans:saveSignature', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('loans:getPaymentHistory', async (event, loanId) => {
  await ensureDbReady();
  try { return db.getLoanPaymentHistory(loanId); } catch (err) { console.error('loans:getPaymentHistory', err); return []; }
});

ipcMain.handle('loans:updateCollateralValue', async (event, loanId, value) => {
  await ensureDbReady();
  try { return db.updateCollateralValue(loanId, value); } catch (err) { console.error('loans:updateCollateralValue', err); return { success: false, error: err.message }; }
});

// ==========================================
// LOAN ENGINE IPC HANDLERS (v2.3.0)
// ==========================================

// Create loan with full installment schedule
ipcMain.handle('loans:createWithSchedule', async (event, loanData) => {
  await ensureDbReady();
  try { 
    const result = db.createLoanWithSchedule(loanData);
    if (result.success) {
      db.logAudit('CREATE', 'loan', result.id, null, JSON.stringify({ loanNumber: result.loanNumber, ...loanData }));
    }
    return result;
  } catch (err) { 
    console.error('loans:createWithSchedule', err); 
    return { success: false, error: err.message }; 
  }
});

// Get loan installments/schedule
ipcMain.handle('loans:getInstallments', async (event, loanId) => {
  await ensureDbReady();
  try { return db.getLoanInstallments(loanId); } catch (err) { console.error('loans:getInstallments', err); return []; }
});

// Allocate payment to installments
ipcMain.handle('loans:allocatePayment', async (event, paymentData) => {
  await ensureDbReady();
  try { 
    const result = db.allocatePayment(paymentData);
    return result;
  } catch (err) { 
    console.error('loans:allocatePayment', err); 
    return { success: false, error: err.message }; 
  }
});

// Recalculate loan status
ipcMain.handle('loans:recalculateStatus', async (event, loanId) => {
  await ensureDbReady();
  try { return db.recalculateLoanStatus(loanId); } catch (err) { console.error('loans:recalculateStatus', err); return { success: false, error: err.message }; }
});

// Assess default and apply late fees
ipcMain.handle('loans:assessDefault', async (event, loanId) => {
  await ensureDbReady();
  try { return db.assessDefault(loanId); } catch (err) { console.error('loans:assessDefault', err); return { success: false, error: err.message }; }
});

// Sync client loan data
ipcMain.handle('loans:syncClientData', async (event, clientId) => {
  await ensureDbReady();
  try { return db.syncClientLoanData(clientId); } catch (err) { console.error('loans:syncClientData', err); return { success: false, error: err.message }; }
});

// Run batch assessment on all active loans
ipcMain.handle('loans:runBatchAssessment', async () => {
  await ensureDbReady();
  try { return db.runBatchAssessment(); } catch (err) { console.error('loans:runBatchAssessment', err); return { success: false, error: err.message }; }
});

// Get loan summary with schedule status
ipcMain.handle('loans:getSummary', async (event, loanId) => {
  await ensureDbReady();
  try { return db.getLoanSummary(loanId); } catch (err) { console.error('loans:getSummary', err); return null; }
});

// Get overdue installments across all loans
ipcMain.handle('loans:getOverdueInstallments', async () => {
  await ensureDbReady();
  try { return db.getOverdueInstallments(); } catch (err) { console.error('loans:getOverdueInstallments', err); return []; }
});

// Get upcoming installments
ipcMain.handle('loans:getUpcomingInstallments', async (event, daysAhead = 7) => {
  await ensureDbReady();
  try { return db.getUpcomingInstallments(daysAhead); } catch (err) { console.error('loans:getUpcomingInstallments', err); return []; }
});

// ==============================================
// EARLY SETTLEMENT HANDLERS
// ==============================================

// Get early settlement advisory (preview)
ipcMain.handle('loans:getEarlySettlementAdvisory', async (event, loanId) => {
  await ensureDbReady();
  try {
    return db.getEarlySettlementAdvisory(loanId);
  } catch (err) {
    console.error('loans:getEarlySettlementAdvisory', err);
    return { success: false, error: err.message };
  }
});

// Calculate early settlement amount
ipcMain.handle('loans:calculateEarlySettlement', async (event, loanId) => {
  await ensureDbReady();
  try {
    return db.calculateEarlySettlement(loanId);
  } catch (err) {
    console.error('loans:calculateEarlySettlement', err);
    return { success: false, error: err.message };
  }
});

// Apply early settlement
ipcMain.handle('loans:applyEarlySettlement', async (event, loanId, paymentAmount, notes) => {
  await ensureDbReady();
  try {
    const result = db.applyEarlySettlement(loanId, paymentAmount, event.sender.userId || 'system', notes);
    return result;
  } catch (err) {
    console.error('loans:applyEarlySettlement', err);
    return { success: false, error: err.message };
  }
});

// Enable/disable early settlement for a loan
ipcMain.handle('loans:setEarlySettlementEnabled', async (event, loanId, enabled, customRates) => {
  await ensureDbReady();
  try {
    return db.setEarlySettlementEnabled(loanId, enabled, customRates);
  } catch (err) {
    console.error('loans:setEarlySettlementEnabled', err);
    return { success: false, error: err.message };
  }
});

// Get early settlement report
ipcMain.handle('loans:getEarlySettlementReport', async (event, startDate, endDate) => {
  await ensureDbReady();
  try {
    return db.getEarlySettlementReport(startDate, endDate);
  } catch (err) {
    console.error('loans:getEarlySettlementReport', err);
    return { success: false, error: err.message, settlements: [] };
  }
});

// Get default early settlement rates
ipcMain.handle('loans:getDefaultEarlySettlementRates', async () => {
  return db.getDefaultEarlySettlementRates();
});

// (duplicate handlers removed to prevent double-registration)

ipcMain.handle('payments:add', async (event, payload) => {
  await ensureDbReady();
  try{ 
    const res = db.addPayment(payload);
    // Apply penalties after payment recorded
    try {
      db.applyAutoPenalties();
    } catch (err) {
      console.error('Auto-penalty error after payment:', err);
    }
    // Recalculate loan status and sync client data
    try {
      if (payload.loanId) {
        db.recalculateLoanStatus(payload.loanId);
        // Get client ID from loan and sync
        const loanRes = db.exec(`SELECT clientId FROM loans WHERE id = ?`, [payload.loanId]);
        const clientId = loanRes[0]?.values?.[0]?.[0];
        if (clientId) {
          db.syncClientLoanData(clientId);
        }
      }
    } catch (syncErr) {
      console.error('Payment sync error:', syncErr);
    }
    return { success: true };
  }catch(err){ return { success:false, error:err.message } }
});

ipcMain.handle('payments:getByLoan', async (event, loanId) => {
  await ensureDbReady();
  try{ return db.getPaymentsByLoan(loanId); }catch(err){ console.error('payments:getByLoan', err); return [] }
});

ipcMain.handle('payments:getByClient', async (event, clientId) => {
  await ensureDbReady();
  try{
    // Get all loans for this client, then get payments for each
    const loans = db.getLoansByClient(clientId);
    const payments = [];
    for (const loan of loans) {
      const loanPayments = db.getPaymentsByLoan(loan.id);
      payments.push(...loanPayments.map(p => ({ ...p, loanNumber: loan.loanNumber })));
    }
    return payments;
  }catch(err){ console.error('payments:getByClient', err); return [] }
});

ipcMain.handle('payments:getAll', async () => {
  await ensureDbReady();
  try{ return db.getAllPayments(); }catch(err){ console.error('payments:getAll', err); return [] }
});

ipcMain.handle('payments:update', async (event, id, payload) => {
  await ensureDbReady();
  try{ return db.updatePayment(id, payload); }catch(err){ return { success:false, error:err.message } }
});

ipcMain.handle('payments:delete', async (event, id) => {
  await ensureDbReady();
  try{ return db.deletePayment(id); }catch(err){ return { success:false, error:err.message } }
});

ipcMain.handle('payments:getById', async (event, id) => {
  await ensureDbReady();
  try{ return db.getPaymentById(id); }catch(err){ return null }
});

// ===== PAYMENT ANALYTICS & FINANCIAL REPORTING (v2.4.0) =====

ipcMain.handle('payments:addEnhanced', async (event, payload) => {
  await ensureDbReady();
  try {
    const res = db.addPaymentEnhanced(payload);
    // Apply penalties after payment recorded
    try { db.applyAutoPenalties(); } catch (err) { console.error('Auto-penalty error:', err); }
    // Sync loan status and client data
    if (payload.loanId) {
      try {
        db.recalculateLoanStatus(payload.loanId);
        const loanRes = db.exec(`SELECT clientId FROM loans WHERE id = ?`, [payload.loanId]);
        if (loanRes[0]?.values?.[0]?.[0]) db.syncClientLoanData(loanRes[0].values[0][0]);
      } catch (syncErr) { console.error('Payment sync error:', syncErr); }
    }
    return res;
  } catch (err) { return { success: false, error: err.message } }
});

ipcMain.handle('payments:getEnhanced', async (event, filters) => {
  await ensureDbReady();
  try { return db.getPaymentsEnhanced(filters); } catch (err) { console.error('payments:getEnhanced', err); return []; }
});

ipcMain.handle('payments:reverse', async (event, paymentId, reason, reversedBy) => {
  await ensureDbReady();
  try { return db.reversePayment(paymentId, reason, reversedBy); } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('payments:generateReceipt', async (event) => {
  await ensureDbReady();
  try { return db.generateReceiptNumber(); } catch (err) { return null; }
});

ipcMain.handle('payments:getStats', async (event, period) => {
  await ensureDbReady();
  try { return db.getPaymentStats(period); } catch (err) { console.error('payments:getStats', err); return { error: err.message }; }
});

ipcMain.handle('payments:getProfitAnalysis', async (event, startDate, endDate) => {
  await ensureDbReady();
  try { return db.getProfitAnalysis(startDate, endDate); } catch (err) { return { error: err.message }; }
});

ipcMain.handle('payments:getCollectionTrends', async (event) => {
  await ensureDbReady();
  try { return db.getCollectionTrends(); } catch (err) { return { error: err.message }; }
});

ipcMain.handle('payments:getFinancialAdvisory', async (event) => {
  await ensureDbReady();
  try { return db.getFinancialAdvisory(); } catch (err) { return { error: err.message, advisories: [] }; }
});

ipcMain.handle('payments:getDailyReport', async (event, date) => {
  await ensureDbReady();
  try { return db.getDailyCollectionReport(date); } catch (err) { return { error: err.message }; }
});

ipcMain.handle('payments:getChartData', async (event, period, groupBy) => {
  await ensureDbReady();
  try { return db.getPaymentChartData(period, groupBy); } catch (err) { return { error: err.message }; }
});

ipcMain.handle('payments:addPromise', async (event, promiseData) => {
  await ensureDbReady();
  try { return db.addPaymentPromise(promiseData); } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('payments:getPromises', async (event, filters) => {
  await ensureDbReady();
  try { return db.getPaymentPromises(filters); } catch (err) { return []; }
});

ipcMain.handle('payments:updatePromiseStatus', async (event, promiseId, status, paymentId) => {
  await ensureDbReady();
  try { return db.updatePaymentPromiseStatus(promiseId, status, paymentId); } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('payments:getPipeline', async (event, days) => {
  await ensureDbReady();
  try { return db.getPaymentPipeline(days); } catch (err) { return { error: err.message }; }
});

ipcMain.handle('penalties:add', async (event, payload) => {
  await ensureDbReady();
  try{ return db.addPenalty(payload); }catch(err){ return { success:false, error:err.message } }
});

ipcMain.handle('penalties:getByLoan', async (event, loanId) => {
  await ensureDbReady();
  try{ return db.getPenaltiesByLoan(loanId); }catch(err){ return [] }
});

ipcMain.handle('audit:get', async () => {
  await ensureDbReady();
  try{ return db.getAuditLog(); }catch(err){ return [] }
});

ipcMain.handle('audit:clear', async () => {
  await ensureDbReady();
  try{ return db.clearAuditLog(); }catch(err){ return { success:false, error:err.message } }
});

ipcMain.handle('audit:delete', async (event, id) => {
  await ensureDbReady();
  try{ return db.deleteAuditEntry(id); }catch(err){ return { success:false, error:err.message } }
});

ipcMain.handle('settings:get', async (event, key) => {
  await ensureDbReady();
  try{ return db.getSettingByKey(key); }catch(err){ return null }
});

ipcMain.handle('settings:getAll', async () => {
  await ensureDbReady();
  try{ return db.getAllSettings(); }catch(err){ return {} }
});

ipcMain.handle('settings:set', async (event, key, value) => {
  await ensureDbReady();
  try{ return db.setSetting(key, value); }catch(err){ return { success:false, error:err.message } }
});

// Auto-Penalty System: Apply penalties daily
ipcMain.handle('penalties:applyAuto', async () => {
  try{ return db.applyAutoPenalties(); }catch(err){ return { success:false, error:err.message } }
});

ipcMain.handle('penalties:getAll', async () => {
  await ensureDbReady();
  try{ return db.getAllPenalties(); }catch(err){ return [] }
});

ipcMain.handle('penalties:updateStatus', async (event, id, status) => {
  await ensureDbReady();
  try{ return db.updatePenaltyStatus(id, status); }catch(err){ return { success:false, error:err.message } }
});

ipcMain.handle('penalties:delete', async (event, id) => {
  await ensureDbReady();
  try{ return db.deletePenalty(id); }catch(err){ return { success:false, error:err.message } }
});

// ===== COLLATERAL MANAGEMENT =====
ipcMain.handle('collateral:add', async (event, data) => {
  console.log('[IPC] collateral:add called with:', JSON.stringify(data));
  try {
    await ensureDbReady();
    const res = db.addCollateral(data);
    console.log('[IPC] collateral:add result:', res);
    return res;
  } catch (err) {
    console.error('[IPC-ERROR] collateral:add exception:', err?.message || err);
    return { success: false, error: err?.message || err?.toString() || String(err) };
  }
});

ipcMain.handle('collateral:update', async (event, id, data) => {
  try {
    await ensureDbReady();
    return db.updateCollateral(id, data);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('collateral:delete', async (event, id) => {
  try {
    await ensureDbReady();
    return db.deleteCollateral(id);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('collateral:getByClient', async (event, clientId) => {
  try {
    await ensureDbReady();
    return db.getCollateralByClient(clientId);
  } catch (err) {
    return [];
  }
});

ipcMain.handle('collateral:getByLoan', async (event, loanId) => {
  try {
    await ensureDbReady();
    return db.getCollateralByLoan(loanId);
  } catch (err) {
    return [];
  }
});

ipcMain.handle('collateral:getAll', async () => {
  try {
    await ensureDbReady();
    return db.getAllCollateral();
  } catch (err) {
    return [];
  }
});

ipcMain.handle('collateral:forfeit', async (event, id) => {
  try {
    return db.forfeitCollateral(id);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('collateral:selectImage', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp'] }],
      title: 'Select Collateral Images (multiple allowed)'
    });
    if (!result.canceled && result.filePaths.length > 0) {
      // Validate file sizes (max 10MB per image)
      const MAX_SIZE = 10 * 1024 * 1024;
      for (const filePath of result.filePaths) {
        const stats = fs.statSync(filePath);
        if (stats.size > MAX_SIZE) {
          return { success: false, error: `Image "${path.basename(filePath)}" too large (max 10MB). Size: ${(stats.size/1024/1024).toFixed(1)}MB` };
        }
      }
      return { success: true, paths: result.filePaths };
    }
    return { success: false, error: 'No file selected' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('collateral:selectDocument', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'txt'] }],
      title: 'Select Collateral Document'
    });
    if (!result.canceled && result.filePaths.length > 0) {
      // Validate file size (max 20MB)
      const filePath = result.filePaths[0];
      const stats = fs.statSync(filePath);
      const MAX_SIZE = 20 * 1024 * 1024;
      
      if (stats.size > MAX_SIZE) {
        return { success: false, error: `Document too large (max 20MB). Size: ${(stats.size/1024/1024).toFixed(1)}MB` };
      }
      
      return { success: true, path: filePath };
    }
    return { success: false, error: 'No file selected' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// PAYMENT RECEIPTS & LOAN AGREEMENTS
const toBool = (value, defaultValue = true) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() !== 'false';
};

ipcMain.handle('export:paymentReceipt', async (event, paymentId, loanId, companyName, accent = '#0d9488', receiptTitle = 'Payment Receipt', receiptFooter = 'Thank you for your payment', options = {}) => {
  try{
    const companyPhone = db.getSettingByKey('companyPhone') || '';
    const companyEmail = db.getSettingByKey('companyEmail') || '';
    const companyAddress = db.getSettingByKey('companyAddress') || '';
    const companyTagline = db.getSettingByKey('companyTagline') || 'Your Trusted Financial Partner';
    const companyRegistration = db.getSettingByKey('companyRegistration') || '';
    const companyTpin = db.getSettingByKey('companyTpin') || '';
    const companyWebsite = db.getSettingByKey('companyWebsite') || '';
    const bankName = db.getSettingByKey('bankName') || '';
    const accountNumber = db.getSettingByKey('accountNumber') || '';
    const bankBranch = db.getSettingByKey('bankBranch') || '';
    const companyLogo = db.getSettingByKey('companyLogo') || ''; // Base64 logo
    const showCompanyPhone = toBool(options.showCompanyPhone, toBool(db.getSettingByKey('docShowCompanyPhone'), true));
    const showCompanyEmail = toBool(options.showCompanyEmail, toBool(db.getSettingByKey('docShowCompanyEmail'), true));
    const showCompanyAddress = toBool(options.showCompanyAddress, toBool(db.getSettingByKey('docShowCompanyAddress'), true));
    const showBankDetails = toBool(options.showBankDetails, toBool(db.getSettingByKey('docShowBankDetails'), false));
    
    // Get payment using object-based API
    const payment = db.getPaymentsByLoan(loanId).find(p => p.id === paymentId);
    if (!payment) return { success: false, error: 'Payment not found' };
    
    // Get loan using object-based API
    const loans = db.getLoans().filter(l => l.id === loanId);
    if (!loans.length) return { success: false, error: 'Loan not found' };
    const loan = loans[0];
    
    // Get client using object-based API
    const clients = db.getClients().filter(c => c.id === loan.clientId);
    if (!clients.length) return { success: false, error: 'Client not found' };
    const client = clients[0];
    
    const receiptNumber = `RCP-${String(paymentId).padStart(6, '0')}-${new Date().getFullYear()}`;
    const paymentMethod = payment.paymentMethod || 'Cash';
    const loanAmount = parseFloat(loan.amount) || 0;
    const loanInterest = parseFloat(loan.interest) || 0;
    const interestAmount = loanAmount * loanInterest / 100;
    const totalLoanAmount = loanAmount + interestAmount;
    const formattedDate = new Date(payment.paymentDate).toLocaleDateString('en-GB', {year:'numeric',month:'long',day:'numeric'});
    const formattedTime = new Date().toLocaleTimeString('en-US', {hour:'2-digit',minute:'2-digit'});
    
    // Calculate loan balance info
    const allPayments = db.getPaymentsByLoan(loanId);
    const totalPaid = allPayments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    const remainingBalance = Math.max(0, totalLoanAmount - totalPaid);
    const paymentCount = allPayments.length;
    
    // Determine payment status
    let paymentStatus = 'PARTIAL PAYMENT';
    let statusColor = '#f59e0b';
    if (remainingBalance <= 0) {
      paymentStatus = 'PAID IN FULL';
      statusColor = '#059669';
    } else if (paymentCount === 1) {
      paymentStatus = 'FIRST PAYMENT';
      statusColor = '#3b82f6';
    }
    
    // Logo HTML - either base64 image or styled text fallback
    const logoHtml = companyLogo 
      ? `<img src="${companyLogo}" style="height:70px;max-width:200px;object-fit:contain;" alt="${companyName}">`
      : `<div style="display:flex;align-items:center;gap:12px;">
          <div style="width:60px;height:60px;background:linear-gradient(135deg,${accent} 0%,${accent}dd 100%);border-radius:12px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px ${accent}40;">
            <span style="font-size:28px;font-weight:900;color:white;">${(companyName||'MIG').charAt(0)}</span>
          </div>
          <div>
            <div style="font-size:22px;font-weight:800;color:#0f172a;letter-spacing:-0.5px;">${companyName||'M.I.G LOANS'}</div>
            <div style="font-size:10px;color:#6b7280;font-weight:500;">${companyTagline}</div>
          </div>
        </div>`;
    
    const receiptHtml = `
      <div style="font-family:'Segoe UI',system-ui,-apple-system,sans-serif;max-width:750px;margin:0 auto;padding:0;color:#1f2937;background:#ffffff;line-height:1.5;">
        
        <!-- ===== HEADER SECTION ===== -->
        <div style="background:linear-gradient(135deg,#f8fafc 0%,#f1f5f9 100%);padding:28px 32px;border-bottom:3px solid ${accent};">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <!-- Company Logo & Name -->
            <div>
              ${logoHtml}
            </div>
            
            <!-- Receipt Badge -->
            <div style="text-align:right;">
              <div style="background:${accent};color:white;padding:10px 20px;border-radius:8px;display:inline-block;box-shadow:0 4px 12px ${accent}30;">
                <div style="font-size:18px;font-weight:800;letter-spacing:1px;">${receiptTitle.toUpperCase()}</div>
              </div>
              <div style="margin-top:10px;font-size:11px;color:#6b7280;">
                <div style="font-weight:600;color:#0f172a;">#${receiptNumber}</div>
                <div>${formattedDate} • ${formattedTime}</div>
              </div>
            </div>
          </div>
          
          <!-- Company Contact Row -->
          <div style="display:flex;flex-wrap:wrap;gap:16px;margin-top:20px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;">
            ${showCompanyPhone && companyPhone ? `<span style="display:flex;align-items:center;gap:4px;"><span style="color:${accent};">📞</span> ${companyPhone}</span>` : ''}
            ${showCompanyEmail && companyEmail ? `<span style="display:flex;align-items:center;gap:4px;"><span style="color:${accent};">📧</span> ${companyEmail}</span>` : ''}
            ${companyWebsite ? `<span style="display:flex;align-items:center;gap:4px;"><span style="color:${accent};">🌐</span> ${companyWebsite}</span>` : ''}
            ${showCompanyAddress && companyAddress ? `<span style="display:flex;align-items:center;gap:4px;"><span style="color:${accent};">📍</span> ${companyAddress}</span>` : ''}
          </div>
          ${(companyRegistration || companyTpin) ? `
          <div style="margin-top:8px;font-size:10px;color:#94a3b8;">
            ${companyRegistration ? `Reg: ${companyRegistration}` : ''} ${companyRegistration && companyTpin ? ' • ' : ''} ${companyTpin ? `TPIN: ${companyTpin}` : ''}
          </div>` : ''}
        </div>
        
        <!-- ===== MAIN CONTENT ===== -->
        <div style="padding:28px 32px;">
          
          <!-- Payment Status Banner -->
          <div style="background:${statusColor}15;border:2px solid ${statusColor};border-radius:10px;padding:16px 20px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div style="font-size:10px;color:${statusColor};text-transform:uppercase;font-weight:700;letter-spacing:1px;">Payment Status</div>
              <div style="font-size:20px;font-weight:800;color:${statusColor};">${paymentStatus}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:10px;color:#6b7280;text-transform:uppercase;">Amount Received</div>
              <div style="font-size:28px;font-weight:900;color:${statusColor};font-family:'Courier New',monospace;">K ${parseFloat(payment.amount).toLocaleString('en-US', {minimumFractionDigits:2})}</div>
            </div>
          </div>
          
          <!-- Client & Loan Info Grid -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px;">
            
            <!-- Client Information -->
            <div style="background:#f8fafc;border-radius:10px;padding:20px;border:1px solid #e2e8f0;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid ${accent};">
                <span style="font-size:18px;">👤</span>
                <span style="font-size:12px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.5px;">Client Information</span>
              </div>
              <table style="width:100%;font-size:12px;">
                <tr>
                  <td style="padding:6px 0;color:#64748b;width:90px;">Name:</td>
                  <td style="padding:6px 0;font-weight:600;color:#0f172a;">${client.name || 'N/A'}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#64748b;">Client No:</td>
                  <td style="padding:6px 0;font-weight:600;color:${accent};font-family:monospace;">${client.clientNumber || 'N/A'}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#64748b;">Phone:</td>
                  <td style="padding:6px 0;font-weight:600;color:#0f172a;">${client.phone || 'N/A'}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#64748b;">NRC:</td>
                  <td style="padding:6px 0;font-weight:600;color:#0f172a;">${client.nrc || 'N/A'}</td>
                </tr>
              </table>
            </div>
            
            <!-- Loan Information -->
            <div style="background:#f8fafc;border-radius:10px;padding:20px;border:1px solid #e2e8f0;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid #3b82f6;">
                <span style="font-size:18px;">📋</span>
                <span style="font-size:12px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.5px;">Loan Details</span>
              </div>
              <table style="width:100%;font-size:12px;">
                <tr>
                  <td style="padding:6px 0;color:#64748b;width:90px;">Loan No:</td>
                  <td style="padding:6px 0;font-weight:600;color:#3b82f6;font-family:monospace;">${loan.loanNumber || 'LN-' + loanId}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#64748b;">Issue Date:</td>
                  <td style="padding:6px 0;font-weight:600;color:#0f172a;">${loan.loanDate || 'N/A'}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#64748b;">Due Date:</td>
                  <td style="padding:6px 0;font-weight:600;color:#0f172a;">${loan.dueDate || 'N/A'}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#64748b;">Duration:</td>
                  <td style="padding:6px 0;font-weight:600;color:#0f172a;">${loan.loanTerm || 'N/A'} ${loan.termType || 'months'}</td>
                </tr>
              </table>
            </div>
          </div>
          
          <!-- Payment Details Table -->
          <div style="margin-bottom:24px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
              <span style="font-size:18px;">💳</span>
              <span style="font-size:12px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.5px;">Payment Breakdown</span>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
              <thead>
                <tr style="background:#f1f5f9;">
                  <th style="padding:12px 16px;text-align:left;font-weight:600;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #e2e8f0;">Description</th>
                  <th style="padding:12px 16px;text-align:right;font-weight:600;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #e2e8f0;">Amount (ZMW)</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;">Principal Amount</td>
                  <td style="padding:14px 16px;text-align:right;font-family:monospace;font-weight:500;border-bottom:1px solid #f1f5f9;">K ${loanAmount.toLocaleString('en-US', {minimumFractionDigits:2})}</td>
                </tr>
                <tr>
                  <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;">Interest (${loanInterest}%)</td>
                  <td style="padding:14px 16px;text-align:right;font-family:monospace;font-weight:500;border-bottom:1px solid #f1f5f9;">K ${interestAmount.toLocaleString('en-US', {minimumFractionDigits:2})}</td>
                </tr>
                <tr style="background:#f8fafc;">
                  <td style="padding:14px 16px;font-weight:700;border-bottom:1px solid #e2e8f0;">Total Loan Amount</td>
                  <td style="padding:14px 16px;text-align:right;font-family:monospace;font-weight:700;border-bottom:1px solid #e2e8f0;">K ${totalLoanAmount.toLocaleString('en-US', {minimumFractionDigits:2})}</td>
                </tr>
                <tr>
                  <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;">Total Paid to Date (${paymentCount} payment${paymentCount !== 1 ? 's' : ''})</td>
                  <td style="padding:14px 16px;text-align:right;font-family:monospace;font-weight:500;color:#059669;border-bottom:1px solid #f1f5f9;">K ${totalPaid.toLocaleString('en-US', {minimumFractionDigits:2})}</td>
                </tr>
                <tr style="background:#fef2f2;">
                  <td style="padding:14px 16px;font-weight:600;color:#991b1b;">Outstanding Balance</td>
                  <td style="padding:14px 16px;text-align:right;font-family:monospace;font-weight:700;color:#dc2626;">K ${remainingBalance.toLocaleString('en-US', {minimumFractionDigits:2})}</td>
                </tr>
              </tbody>
            </table>
          </div>
          
          <!-- This Payment Box -->
          <div style="background:linear-gradient(135deg,${accent}10 0%,${accent}20 100%);border:2px solid ${accent};border-radius:10px;padding:20px;margin-bottom:24px;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px;">
              <div>
                <div style="font-size:11px;color:${accent};text-transform:uppercase;font-weight:700;letter-spacing:1px;margin-bottom:4px;">Current Payment</div>
                <div style="font-size:36px;font-weight:900;color:#0f172a;font-family:'Courier New',monospace;">K ${parseFloat(payment.amount).toLocaleString('en-US', {minimumFractionDigits:2})}</div>
              </div>
              <div style="text-align:right;">
                <div style="display:grid;gap:6px;font-size:12px;">
                  <div><span style="color:#64748b;">Payment Method:</span> <strong style="color:#0f172a;">${paymentMethod}</strong></div>
                  <div><span style="color:#64748b;">Payment Date:</span> <strong style="color:#0f172a;">${formattedDate}</strong></div>
                  <div><span style="color:#64748b;">Reference:</span> <strong style="color:${accent};font-family:monospace;">#${receiptNumber}</strong></div>
                </div>
              </div>
            </div>
          </div>
          
          ${payment.notes ? `
          <!-- Payment Notes -->
          <div style="background:#fef3c7;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:14px 18px;margin-bottom:24px;">
            <div style="font-size:10px;color:#92400e;text-transform:uppercase;font-weight:700;letter-spacing:0.5px;margin-bottom:6px;">📝 Payment Notes</div>
            <div style="font-size:12px;color:#78350f;line-height:1.6;">${payment.notes}</div>
          </div>` : ''}
          
          ${showBankDetails && (bankName || accountNumber) ? `
          <!-- Bank Details -->
          <div style="background:#eff6ff;border-left:4px solid #3b82f6;border-radius:0 8px 8px 0;padding:14px 18px;margin-bottom:24px;">
            <div style="font-size:10px;color:#1e40af;text-transform:uppercase;font-weight:700;letter-spacing:0.5px;margin-bottom:8px;">🏦 Bank Details for Future Payments</div>
            <div style="font-size:12px;color:#1e3a8a;display:flex;flex-wrap:wrap;gap:20px;">
              ${bankName ? `<span><strong>Bank:</strong> ${bankName}</span>` : ''}
              ${bankBranch ? `<span><strong>Branch:</strong> ${bankBranch}</span>` : ''}
              ${accountNumber ? `<span><strong>Account:</strong> ${accountNumber}</span>` : ''}
            </div>
          </div>` : ''}
          
          <!-- Signature Section -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:40px;margin:32px 0;padding-top:24px;border-top:2px dashed #e2e8f0;">
            <div style="text-align:center;">
              <div style="height:60px;border-bottom:2px solid #1f2937;margin-bottom:8px;"></div>
              <div style="font-size:11px;color:#64748b;font-weight:600;">Authorized Signature</div>
              <div style="font-size:10px;color:#94a3b8;margin-top:2px;">${companyName || 'M.I.G Loans'}</div>
            </div>
            <div style="text-align:center;">
              <div style="height:60px;border-bottom:2px solid #1f2937;margin-bottom:8px;"></div>
              <div style="font-size:11px;color:#64748b;font-weight:600;">Client Signature</div>
              <div style="font-size:10px;color:#94a3b8;margin-top:2px;">${client.name || 'Client'}</div>
            </div>
          </div>
        </div>
        
        <!-- ===== FOOTER ===== -->
        <div style="background:#f8fafc;padding:20px 32px;border-top:1px solid #e2e8f0;">
          <div style="text-align:center;margin-bottom:16px;">
            <div style="font-size:13px;color:#0f172a;font-weight:600;margin-bottom:4px;">✓ ${receiptFooter}</div>
            <div style="font-size:10px;color:#64748b;">This receipt serves as official proof of payment. Please retain for your records.</div>
          </div>
          
          <div style="display:flex;justify-content:space-between;align-items:center;padding-top:12px;border-top:1px solid #e2e8f0;font-size:9px;color:#94a3b8;">
            <div>Generated: ${new Date().toLocaleString('en-GB', {dateStyle:'medium',timeStyle:'short'})}</div>
            <div>Receipt: ${receiptNumber}</div>
            <div>${companyName || 'M.I.G Loans'}</div>
          </div>
        </div>
        
        <!-- Tear Line -->
        <div style="padding:8px;border-top:2px dashed #cbd5e1;background:#f8fafc;text-align:center;">
          <span style="font-size:8px;color:#94a3b8;text-transform:uppercase;letter-spacing:2px;">✂ Customer Copy - Please Keep for Your Records</span>
        </div>
      </div>
    `;
    
    return { success: true, html: receiptHtml };
  }catch(err){ 
    console.error('[export:paymentReceipt] Error:', err);
    return { success: false, error: err.message };
  }
});

// CSV exports (data URLs)
ipcMain.handle('export:clientsCSV', async () => {
  await ensureDbReady();
  try {
    const rows = db.getClients();
    const header = ['id','clientNumber','name','phone','nrc','email','notes','created_at'];
    const csv = [header.join(',')].concat(rows.map(r => header.map(k => JSON.stringify(r[k] ?? '')).join(','))).join('\n');
    return { success: true, url: `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}` };
  } catch (err) {
    console.error('[IPC-ERROR] export:clientsCSV', err);
    return { success: false, error: err?.message || 'Export failed' };
  }
});

ipcMain.handle('export:loansCSV', async () => {
  await ensureDbReady();
  try {
    const rows = db.getLoans();
    const header = ['id','loanNumber','clientId','amount','interest','loanDate','dueDate','status','notes','collateral','collateralValue','balance','paidAmount','penaltiesTotal'];
    const csv = [header.join(',')].concat(rows.map(r => header.map(k => JSON.stringify(r[k] ?? '')).join(','))).join('\n');
    return { success: true, url: `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}` };
  } catch (err) {
    console.error('[IPC-ERROR] export:loansCSV', err);
    return { success: false, error: err?.message || 'Export failed' };
  }
});

ipcMain.handle('export:paymentsCSV', async () => {
  await ensureDbReady();
  try {
    const rows = db.getAllPayments();
    const header = ['id','loanId','amount','paymentDate','notes'];
    const csv = [header.join(',')].concat(rows.map(r => header.map(k => JSON.stringify(r[k] ?? '')).join(','))).join('\n');
    return { success: true, url: `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}` };
  } catch (err) {
    console.error('[IPC-ERROR] export:paymentsCSV', err);
    return { success: false, error: err?.message || 'Export failed' };
  }
});

ipcMain.handle('export:comprehensiveReport', async () => {
  await ensureDbReady();
  try {
    const companyName = db.getSettingByKey('companyName') || 'M.I.G Loans';
    const companyPhone = db.getSettingByKey('companyPhone') || '';
    const companyEmail = db.getSettingByKey('companyEmail') || '';
    const companyAddress = db.getSettingByKey('companyAddress') || '';
    const loans = db.getLoans();
    const clients = db.getClients();
    const payments = db.getAllPayments();
    const totalPortfolio = loans.reduce((s,l)=>s+Number(l.amount||0),0);
    const totalBalance = loans.reduce((s,l)=>s+Number(l.balance||0),0);
    const totalPaid = loans.reduce((s,l)=>s+Number(l.paidAmount||0),0);
    const activeLoans = loans.filter(l => l.balance > 0).length;
    const paidLoans = loans.filter(l => l.balance <= 0).length;
    
    const reportHtml = `
      <div style="font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;color:#1f2937;line-height:1.6;background:#ffffff">
        <!-- PAGE 1: HEADER & EXECUTIVE SUMMARY -->
        <div style="padding:40px;border-bottom:3px solid #0d9488">
          <!-- Company Header -->
          <div style="background:linear-gradient(135deg,#0d9488 0%,#14b8a6 100%);color:white;padding:28px;border-radius:8px;margin-bottom:24px;text-align:center">
            <div style="font-size:32px;font-weight:700;letter-spacing:0.5px;margin:0">${companyName.toUpperCase()}</div>
            <div style="font-size:13px;opacity:0.9;margin-top:8px">Loan Portfolio Management Report</div>
          </div>
          
          <!-- Company Details Grid -->
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px;font-size:11px">
            <div style="padding:12px;background:#f9fafb;border-radius:6px;border-left:3px solid #0d9488">
              <div style="color:#6b7280;font-weight:600;text-transform:uppercase;margin-bottom:6px">📞 Phone</div>
              <div style="font-weight:700;color:#0f172a">${companyPhone || 'N/A'}</div>
            </div>
            <div style="padding:12px;background:#f9fafb;border-radius:6px;border-left:3px solid #0d9488">
              <div style="color:#6b7280;font-weight:600;text-transform:uppercase;margin-bottom:6px">✉ Email</div>
              <div style="font-weight:700;color:#0f172a">${companyEmail || 'N/A'}</div>
            </div>
            <div style="padding:12px;background:#f9fafb;border-radius:6px;border-left:3px solid #0d9488">
              <div style="color:#6b7280;font-weight:600;text-transform:uppercase;margin-bottom:6px">📍 Address</div>
              <div style="font-weight:700;color:#0f172a">${companyAddress || 'N/A'}</div>
            </div>
          </div>
          
          <div style="text-align:center;font-size:12px;color:#9ca3af">Report Generated: ${new Date().toLocaleString()}</div>
        </div>
        
        <!-- EXECUTIVE SUMMARY METRICS -->
        <div style="padding:40px">
          <h1 style="color:#0d9488;font-size:22px;margin:0 0 20px 0;letter-spacing:0.5px;text-transform:uppercase">Executive Summary</h1>
          
          <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:32px">
            <div style="padding:16px;background:linear-gradient(135deg,#f0fdf4 0%,#ecfdf5 100%);border-radius:8px;border-left:4px solid #10b981;text-align:center">
              <div style="font-size:11px;color:#065f46;text-transform:uppercase;font-weight:600">Total Clients</div>
              <div style="font-size:24px;font-weight:700;color:#10b981;margin-top:8px">${clients.length}</div>
            </div>
            <div style="padding:16px;background:linear-gradient(135deg,#f0f9ff 0%,#e0f2fe 100%);border-radius:8px;border-left:4px solid #3b82f6;text-align:center">
              <div style="font-size:11px;color:#1e40af;text-transform:uppercase;font-weight:600">Total Loans</div>
              <div style="font-size:24px;font-weight:700;color:#3b82f6;margin-top:8px">${loans.length}</div>
            </div>
            <div style="padding:16px;background:linear-gradient(135deg,#fef3c7 0%,#fef08a 100%);border-radius:8px;border-left:4px solid #f59e0b;text-align:center">
              <div style="font-size:11px;color:#92400e;text-transform:uppercase;font-weight:600">Active Loans</div>
              <div style="font-size:24px;font-weight:700;color:#f59e0b;margin-top:8px">${activeLoans}</div>
            </div>
            <div style="padding:16px;background:linear-gradient(135deg,#ecfdf5 0%,#d1fae5 100%);border-radius:8px;border-left:4px solid #10b981;text-align:center">
              <div style="font-size:11px;color:#065f46;text-transform:uppercase;font-weight:600">Paid Loans</div>
              <div style="font-size:24px;font-weight:700;color:#059669;margin-top:8px">${paidLoans}</div>
            </div>
            <div style="padding:16px;background:linear-gradient(135deg,#fef2f2 0%,#fee2e2 100%);border-radius:8px;border-left:4px solid #dc2626;text-align:center">
              <div style="font-size:11px;color:#991b1b;text-transform:uppercase;font-weight:600">Outstanding</div>
              <div style="font-size:24px;font-weight:700;color:#dc2626;margin-top:8px">K ${totalBalance.toFixed(0)}</div>
            </div>
          </div>
          
          <h2 style="color:#0d9488;font-size:16px;border-bottom:2px solid #0d9488;padding-bottom:10px;margin-bottom:16px;text-transform:uppercase;letter-spacing:0.5px">Portfolio Overview</h2>
          
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:28px">
            <!-- Left Column: Key Figures -->
            <div>
              <table style="width:100%;font-size:11px;border-collapse:collapse">
                <tr style="background:#f9fafb;border-bottom:2px solid #0d9488">
                  <td style="padding:12px;font-weight:700;color:#0f172a;width:50%">Total Portfolio</td>
                  <td style="padding:12px;text-align:right;font-weight:700;font-size:13px;color:#0d9488">K ${totalPortfolio.toFixed(2)}</td>
                </tr>
                <tr style="border-bottom:1px solid #e5e7eb">
                  <td style="padding:10px;color:#6b7280">Total Disbursed</td>
                  <td style="padding:10px;text-align:right">${loans.length > 0 ? 'K ' + (totalPortfolio / loans.length).toFixed(2) + ' avg' : 'N/A'}</td>
                </tr>
                <tr style="border-bottom:1px solid #e5e7eb">
                  <td style="padding:10px;color:#6b7280">Total Received</td>
                  <td style="padding:10px;text-align:right;color:#10b981;font-weight:600">K ${totalPaid.toFixed(2)}</td>
                </tr>
                <tr style="background:#ecfdf5;border-bottom:2px solid #10b981">
                  <td style="padding:12px;font-weight:700;color:#065f46">Outstanding Balance</td>
                  <td style="padding:12px;text-align:right;font-weight:700;color:#10b981">K ${totalBalance.toFixed(2)}</td>
                </tr>
              </table>
            </div>
            
            <!-- Right Column: Collection Rate -->
            <div style="padding:16px;background:#f0fdf4;border-radius:8px;border-left:4px solid #10b981">
              <div style="font-size:12px;color:#065f46;font-weight:600;text-transform:uppercase;margin-bottom:12px">Collection Performance</div>
              <div style="font-size:28px;font-weight:700;color:#10b981;margin-bottom:8px">${totalPortfolio > 0 ? ((totalPaid / totalPortfolio) * 100).toFixed(1) : '0'}%</div>
              <div style="font-size:10px;color:#6b7280;line-height:1.6">
                <div>✓ Collected: K ${totalPaid.toFixed(2)}</div>
                <div>⏱ Outstanding: K ${totalBalance.toFixed(2)}</div>
                <div style="margin-top:8px;padding-top:8px;border-top:1px solid #d1fae5">
                  Recovery Rate: ${totalPortfolio > 0 ? ((totalPaid / totalPortfolio) * 100).toFixed(1) : '0'}% of portfolio
                </div>
              </div>
            </div>
          </div>
        </div>
        
        <!-- PAGE 2: RECENT TRANSACTIONS -->
        <div style="padding:40px;page-break-before:always;border-top:3px solid #0d9488">
          <h2 style="color:#0d9488;font-size:16px;border-bottom:2px solid #0d9488;padding-bottom:10px;margin-bottom:16px;text-transform:uppercase;letter-spacing:0.5px">Recent Payments & Transactions</h2>
          
          <table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:32px">
            <thead>
              <tr style="background:#0d9488;color:white">
                <th style="padding:12px;text-align:left">Date</th>
                <th style="padding:12px;text-align:left">Loan ID</th>
                <th style="padding:12px;text-align:left">Client</th>
                <th style="padding:12px;text-align:right">Amount</th>
                <th style="padding:12px;text-align:left">Notes</th>
              </tr>
            </thead>
            <tbody>
              ${payments.slice(0,15).map((p, idx) => {
                const loan = loans.find(l => l.id === p.loanId);
                const client = clients.find(c => c.id === loan?.clientId);
                return `<tr style="border-bottom:1px solid #e5e7eb;background:${idx % 2 === 0 ? '#f9fafb' : '#ffffff'}">
                  <td style="padding:10px">${new Date(p.paymentDate).toLocaleDateString()}</td>
                  <td style="padding:10px">#${p.loanId}</td>
                  <td style="padding:10px;font-weight:500">${client?.name || 'Unknown'}</td>
                  <td style="padding:10px;text-align:right;color:#10b981;font-weight:600">K ${Number(p.amount||0).toFixed(2)}</td>
                  <td style="padding:10px;color:#6b7280;font-size:9px">${p.notes || '—'}</td>
                </tr>`;
              }).join('') || '<tr><td colspan="5" style="padding:16px;text-align:center;color:#9ca3af">No payments recorded</td></tr>'}
            </tbody>
          </table>
          
          <h2 style="color:#0d9488;font-size:16px;border-bottom:2px solid #0d9488;padding-bottom:10px;margin-bottom:16px;text-transform:uppercase;letter-spacing:0.5px">Active Loans Summary</h2>
          
          <table style="width:100%;border-collapse:collapse;font-size:9px">
            <thead>
              <tr style="background:#0d9488;color:white">
                <th style="padding:10px;text-align:left">Loan #</th>
                <th style="padding:10px;text-align:left">Client</th>
                <th style="padding:10px;text-align:right">Amount</th>
                <th style="padding:10px;text-align:right">Paid</th>
                <th style="padding:10px;text-align:right">Balance</th>
                <th style="padding:10px;text-align:center">Status</th>
              </tr>
            </thead>
            <tbody>
              ${loans.slice(0,20).map((l, idx) => `<tr style="border-bottom:1px solid #e5e7eb;background:${idx % 2 === 0 ? '#f9fafb' : '#ffffff'}">
                <td style="padding:10px">#${l.loanNumber}</td>
                <td style="padding:10px">${l.clientName}</td>
                <td style="padding:10px;text-align:right">K ${Number(l.amount||0).toFixed(2)}</td>
                <td style="padding:10px;text-align:right;color:#10b981">K ${Number(l.paidAmount||0).toFixed(2)}</td>
                <td style="padding:10px;text-align:right;color:${Number(l.balance||0) > 0 ? '#dc2626' : '#6b7280'}">K ${Number(l.balance||0).toFixed(2)}</td>
                <td style="padding:10px;text-align:center">
                  <span style="background:${Number(l.balance||0) <= 0 ? '#d1fae5' : '#fef3c7'};color:${Number(l.balance||0) <= 0 ? '#065f46' : '#92400e'};padding:4px 8px;border-radius:12px;font-weight:600">
                    ${Number(l.balance||0) <= 0 ? '✓ PAID' : '⏳ ACTIVE'}
                  </span>
                </td>
              </tr>`).join('') || '<tr><td colspan="6" style="padding:16px;text-align:center;color:#9ca3af">No loans</td></tr>'}
            </tbody>
          </table>
          
          <!-- FOOTER -->
          <div style="margin-top:40px;padding-top:16px;border-top:2px solid #e5e7eb;text-align:center;font-size:9px;color:#9ca3af">
            <div style="margin-bottom:8px">Comprehensive Loan Portfolio Report</div>
            <div>${companyName} • Generated: ${new Date().toLocaleString()}</div>
            <div style="margin-top:8px;color:#d1d5db">This report is confidential and for authorized use only.</div>
          </div>
        </div>
      </div>
    `;
    return { success: true, html: reportHtml };
  } catch (err) {
    console.error('[IPC-ERROR] export:comprehensiveReport', err);
    return { success: false, error: err?.message || 'Export failed' };
  }
});

ipcMain.handle('export:loanAgreement', async (event, loanId, companyName, accent = '#0d9488', introText = '', footerText = '', options = {}) => {
  try{
    const loan = db.exec(`SELECT * FROM loans WHERE id = ?`, [loanId]);
    const client = db.exec(`SELECT * FROM clients WHERE id = ?`, [loan[0]?.values[0]?.[1]]);
    const companyPhone = db.getSettingByKey('companyPhone') || '';
    const companyEmail = db.getSettingByKey('companyEmail') || '';
    const companyAddress = db.getSettingByKey('companyAddress') || '';
    const bankName = db.getSettingByKey('bankName') || '';
    const accountNumber = db.getSettingByKey('accountNumber') || '';
    const bankBranch = db.getSettingByKey('bankBranch') || '';
    const companyReg = db.getSettingByKey('companyRegistration') || '';
    const showCompanyPhone = toBool(options.showCompanyPhone, toBool(db.getSettingByKey('docShowCompanyPhone'), true));
    const showCompanyEmail = toBool(options.showCompanyEmail, toBool(db.getSettingByKey('docShowCompanyEmail'), true));
    const showCompanyAddress = toBool(options.showCompanyAddress, toBool(db.getSettingByKey('docShowCompanyAddress'), true));
    const showBankDetails = toBool(options.showBankDetails, toBool(db.getSettingByKey('docShowBankDetails'), false));
    
    if(!loan[0] || !client[0]) return { success: false, error: 'Data not found' };
    
    const loanData = loan[0].values[0];
    const clientData = client[0].values[0];
    const totalAmount = parseFloat(loanData[2]) + (parseFloat(loanData[2]) * parseFloat(loanData[3]) / 100);
    const penaltiesTotal = db.exec(`SELECT COALESCE(SUM(amount),0) FROM penalties WHERE loanId = ?`, [loanId])[0]?.values?.[0]?.[0] || 0;
    const paidAmount = db.exec(`SELECT COALESCE(SUM(amount),0) FROM payments WHERE loanId = ?`, [loanId])[0]?.values?.[0]?.[0] || 0;
    const balance = Math.max(0, totalAmount + penaltiesTotal - paidAmount);
    const agreementNumber = `AGR-${String(loanId).padStart(6,'0')}-${new Date(loanData[5]).getFullYear()}`;
    
    const agreementHtml = `
      <div style="font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;max-width:900px;margin:0 auto;color:#1f2937;line-height:1.6;background:#ffffff">
        <!-- PAGE 1: HEADER & AGREEMENT DETAILS -->
        <div style="padding:40px;border-bottom:3px solid ${accent}">
          <!-- Company Header -->
          <div style="background:linear-gradient(135deg,${accent} 0%,${accent}dd 100%);color:white;padding:24px;border-radius:8px;margin-bottom:24px;text-align:center">
            <div style="font-size:28px;font-weight:700;letter-spacing:0.5px;margin:0">${(companyName||'M.I.G LOANS').toUpperCase()}</div>
            <div style="font-size:12px;opacity:0.9;margin-top:8px">Professional Loan Agreement & Services</div>
          </div>
          
          <!-- Company Contact Info -->
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:24px;font-size:11px;color:#6b7280;text-align:center;padding:12px;background:#f9fafb;border-radius:6px">
            ${showCompanyPhone && companyPhone ? `<div>📞<br><strong>${companyPhone}</strong></div>` : ''}
            ${showCompanyEmail && companyEmail ? `<div>✉<br><strong>${companyEmail}</strong></div>` : ''}
            ${showCompanyAddress && companyAddress ? `<div>📍<br><strong>${companyAddress}</strong></div>` : ''}
            ${showBankDetails && (bankName || accountNumber || bankBranch) ? `<div>🏦<br><strong>${bankName || 'Bank'}${bankBranch ? ` (${bankBranch})` : ''}${accountNumber ? `<br>A/C ${accountNumber}` : ''}</strong></div>` : ''}
          </div>
          
          <!-- Document Title -->
          <h1 style="text-align:center;margin:0 0 8px 0;color:${accent};font-size:26px;letter-spacing:0.5px">LOAN AGREEMENT</h1>
          <div style="text-align:center;font-size:12px;color:#6b7280;margin-bottom:20px">Agreement #LOAN-${loanId}-${new Date().getFullYear()}</div>
          
          ${introText ? `<div style="padding:14px;border-left:4px solid ${accent};background:${accent}0a;color:#0f172a;border-radius:4px;margin-bottom:20px;font-size:12px">${introText}</div>` : ''}
          
          <div style="text-align:center;font-size:11px;color:#9ca3af">Date: ${new Date().toDateString()}</div>
        </div>
        
        <!-- PAGE 1 CONTENT: PARTIES & LOAN TERMS -->
        <div style="padding:40px">
          <h2 style="color:${accent};font-size:16px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid ${accent};padding-bottom:10px;margin-bottom:16px">CONTRACTING PARTIES</h2>
          
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px">
            <!-- Lender -->
            <div style="padding:14px;background:#f9fafb;border-radius:6px;border-left:3px solid ${accent}">
              <div style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:600;margin-bottom:8px">LENDER</div>
              <div style="font-size:14px;font-weight:700;color:#0f172a">${companyName || 'M.I.G Loans Management'}</div>
              <div style="font-size:10px;color:#6b7280;margin-top:8px;line-height:1.5">
                ${showCompanyPhone && companyPhone ? `📞 ${companyPhone}<br>` : ''}
                ${showCompanyEmail && companyEmail ? `✉ ${companyEmail}<br>` : ''}
                ${showCompanyAddress && companyAddress ? `📍 ${companyAddress}<br>` : ''}
                ${showBankDetails && (bankName || accountNumber || bankBranch) ? `🏦 ${bankName || 'Bank'} ${bankBranch ? `(${bankBranch})` : ''}${accountNumber ? `<br>A/C ${accountNumber}` : ''}<br>` : ''}
                ${companyReg ? `Reg: ${companyReg}` : ''}
              </div>
            </div>
            
            <!-- Borrower -->
            <div style="padding:14px;background:#f9fafb;border-radius:6px;border-left:3px solid #10b981">
              <div style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:600;margin-bottom:8px">BORROWER</div>
              <div style="font-size:14px;font-weight:700;color:#0f172a">${clientData[1]}</div>
              <div style="font-size:10px;color:#6b7280;margin-top:8px;line-height:1.5">
                ${clientData[2] ? `📞 ${clientData[2]}<br>` : ''}
                ${clientData[3] ? `ID: ${clientData[3]}` : ''}
                ${clientData[4] ? `<br>📧 ${clientData[4]}` : ''}
              </div>
            </div>
          </div>
          
          <h2 style="color:${accent};font-size:16px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid ${accent};padding-bottom:10px;margin-bottom:16px">LOAN TERMS & CONDITIONS</h2>
          
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:11px">
            <tr style="background:${accent}0a;border-bottom:2px solid ${accent}">
              <td style="padding:12px;font-weight:700;color:#0f172a">Principal Amount</td>
              <td style="padding:12px;text-align:right;font-weight:700;font-size:13px;color:${accent}">K ${parseFloat(loanData[2]).toFixed(2)}</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb">
              <td style="padding:10px;color:#6b7280">Interest Rate</td>
              <td style="padding:10px;text-align:right;font-weight:600">${loanData[3]}%</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb">
              <td style="padding:10px;color:#6b7280">Interest Amount</td>
              <td style="padding:10px;text-align:right">K ${(parseFloat(loanData[2]) * parseFloat(loanData[3]) / 100).toFixed(2)}</td>
            </tr>
            <tr style="background:#fef2f2;border-bottom:2px solid #fee2e2">
              <td style="padding:12px;font-weight:700;color:#991b1b">TOTAL AMOUNT DUE</td>
              <td style="padding:12px;text-align:right;font-weight:700;font-size:14px;color:#dc2626">K ${totalAmount.toFixed(2)}</td>
            </tr>
          </table>
          
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:24px">
            <div style="padding:12px;background:#ecfdf5;border-radius:6px;text-align:center;border:1px solid #d1fae5">
              <div style="font-size:10px;color:#065f46;font-weight:600;text-transform:uppercase">Loan Date</div>
              <div style="font-size:12px;font-weight:700;color:#059669;margin-top:6px">${loanData[5]}</div>
            </div>
            <div style="padding:12px;background:#fef3c7;border-radius:6px;text-align:center;border:1px solid #fde68a">
              <div style="font-size:10px;color:#92400e;font-weight:600;text-transform:uppercase">Due Date</div>
              <div style="font-size:12px;font-weight:700;color:#d97706;margin-top:6px">${loanData[6]}</div>
            </div>
            <div style="padding:12px;background:#f0fdf4;border-radius:6px;text-align:center;border:1px solid #dcfce7">
              <div style="font-size:10px;color:#166534;font-weight:600;text-transform:uppercase">Status</div>
              <div style="font-size:12px;font-weight:700;color:#16a34a;margin-top:6px">${loanData[7].toUpperCase()}</div>
            </div>
          </div>
          
          ${loanData[9] ? `
            <h2 style="color:${accent};font-size:16px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid ${accent};padding-bottom:10px;margin-bottom:16px">COLLATERAL</h2>
            <div style="padding:14px;background:#f0fdf4;border-left:4px solid #10b981;border-radius:4px;color:#0f172a;line-height:1.6">
              <strong style="color:#10b981">💎 Collateral Description:</strong><br>
              <div style="margin-top:8px">${loanData[9]}</div>
              ${loanData[10] ? `<div style="margin-top:8px;color:#6b7280"><strong>Collateral Value:</strong> K ${parseFloat(loanData[10]).toFixed(2)}</div>` : ''}
            </div>
          ` : ''}
        </div>
        
        <!-- PAGE 2: TERMS & CONDITIONS + SIGNATURE -->
        <div style="padding:40px;page-break-before:always;border-top:3px solid ${accent}">
          <h2 style="color:${accent};font-size:16px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid ${accent};padding-bottom:10px;margin-bottom:16px">TERMS & CONDITIONS</h2>
          
          <ol style="margin:0;padding-left:20px;font-size:11px;line-height:1.8;color:#1f2937">
            <li style="margin-bottom:10px">The borrower agrees to repay the principal amount plus interest by the agreed-upon due date.</li>
            <li style="margin-bottom:10px">Late payments will incur daily penalties as per company policy (typically 5% daily penalty rate).</li>
            <li style="margin-bottom:10px">The borrower must maintain contact with the lender regarding payment status and any issues.</li>
            <li style="margin-bottom:10px">This agreement is binding and enforceable under the laws of the jurisdiction in which it is executed.</li>
            <li style="margin-bottom:10px">In case of default, the lender reserves the right to exercise all available remedies, including collection of collateral.</li>
            <li style="margin-bottom:10px">Payments should be made on or before the due date to avoid additional charges and penalties.</li>
            <li style="margin-bottom:10px">This agreement represents the entire agreement between the parties and supersedes all prior arrangements.</li>
          </ol>
          
          <!-- PAYMENT SUMMARY SECTION -->
          <div style="margin-top:28px;padding:14px;background:${accent}0a;border-left:4px solid ${accent};border-radius:4px">
            <div style="font-weight:700;color:${accent};margin-bottom:10px;font-size:12px">CURRENT PAYMENT STATUS</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:10px">
              <div><span style="color:#6b7280">Amount Paid:</span> <strong>K ${paidAmount.toFixed(2)}</strong></div>
              <div><span style="color:#6b7280">Balance:</span> <strong style="color:#dc2626">K ${balance.toFixed(2)}</strong></div>
              ${penaltiesTotal > 0 ? `<div><span style="color:#6b7280">Penalties:</span> <strong style="color:#dc2626">K ${penaltiesTotal.toFixed(2)}</strong></div>` : ''}
            </div>
          </div>
          
          <!-- SIGNATURE BLOCK -->
          <div style="margin-top:40px;padding-top:20px;border-top:2px solid #e5e7eb">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:40px">
              <!-- Borrower Signature -->
              <div>
                <div style="height:50px;border-bottom:1px solid #1f2937;margin-bottom:8px"></div>
                <div style="font-size:10px;color:#6b7280"><strong>Borrower Signature</strong></div>
                <div style="font-size:9px;color:#6b7280;margin-top:2px">Name: ${clientData[1]}</div>
              </div>
              
              <!-- Lender Signature -->
              <div>
                <div style="height:50px;border-bottom:1px solid #1f2937;margin-bottom:8px"></div>
                <div style="font-size:10px;color:#6b7280"><strong>Lender/Authorized Agent</strong></div>
                <div style="font-size:9px;color:#6b7280;margin-top:2px">Company: ${companyName || 'M.I.G Loans'}</div>
              </div>
            </div>
          </div>
          
          <!-- FOOTER -->
          <div style="margin-top:30px;padding-top:16px;border-top:1px solid #e5e7eb;text-align:center;font-size:9px;color:#9ca3af;line-height:1.6">
            ${footerText ? `<div style="margin-bottom:8px;color:#0f172a;font-weight:600">${footerText}</div>` : ''}
            <div>Generated on ${new Date().toLocaleString()}</div>
            <div>${companyName || 'M.I.G Loans'} - Loan Agreement System</div>
          </div>
        </div>
      </div>
    `;
    
    return { success: true, html: agreementHtml };
  }catch(err){ return { success: false, error: err.message } }
});

// Allow renderer to open a file picker to select a logo file
ipcMain.handle('settings:selectLogo', async () => {
  try{
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Company Logo',
      properties: ['openFile'],
      filters: [ { name: 'Images', extensions: ['png','jpg','jpeg','svg','gif','webp'] } ]
    });
    if(res.canceled || !res.filePaths || res.filePaths.length===0) return null;
    return res.filePaths[0];
  }catch(err){ return null }
});

// ===== CLIENT DOCUMENTS HANDLERS =====
ipcMain.handle('clientDocuments:add', async (event, data) => {
  await ensureDbReady();
  try {
    const result = db.addClientDocument(data);
    
    // Copy document to client folder if file path provided
    if (result.success && data.filePath) {
      try {
        const clientRes = db.exec(`SELECT clientNumber, name FROM clients WHERE id = ?`, [data.clientId]);
        if (clientRes[0]?.values[0]) {
          const clientNumber = clientRes[0].values[0][0];
          const clientName = clientRes[0].values[0][1];
          const docFolder = path.join(getClientFolder(clientNumber, clientName), 'documents');
          if (!fs.existsSync(docFolder)) fs.mkdirSync(docFolder, { recursive: true });
          
          if (fs.existsSync(data.filePath)) {
            const ext = path.extname(data.filePath);
            const fileName = `${data.documentType}_${result.id}${ext}`;
            const targetPath = path.join(docFolder, fileName);
            fs.copyFileSync(data.filePath, targetPath);
          }
        }
      } catch (err) {
        console.error('Error copying client document to folder:', err);
      }
    }
    
    return result;
  } catch (err) { console.error('clientDocuments:add', err); return { success: false, error: err.message }; }
});

ipcMain.handle('clientDocuments:get', async (event, clientId) => {
  await ensureDbReady();
  try { return db.getClientDocuments(clientId); } catch (err) { console.error('clientDocuments:get', err); return []; }
});

ipcMain.handle('clientDocuments:delete', async (event, id) => {
  await ensureDbReady();
  try { return db.deleteClientDocument(id); } catch (err) { console.error('clientDocuments:delete', err); return { success: false, error: err.message }; }
});

ipcMain.handle('clientDocuments:selectFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'jpg', 'png'] }] });
  return result.canceled ? null : result.filePaths[0];
});

// ===== COMPANY DOCUMENTS HANDLERS =====
ipcMain.handle('companyDocuments:add', async (event, data) => {
  await ensureDbReady();
  try { return db.addCompanyDocument(data); } catch (err) { console.error('companyDocuments:add', err); return { success: false, error: err.message }; }
});

ipcMain.handle('companyDocuments:get', async () => {
  await ensureDbReady();
  try { return db.getCompanyDocuments(); } catch (err) { console.error('companyDocuments:get', err); return []; }
});

ipcMain.handle('companyDocuments:delete', async (event, id) => {
  await ensureDbReady();
  try { return db.deleteCompanyDocument(id); } catch (err) { console.error('companyDocuments:delete', err); return { success: false, error: err.message }; }
});

ipcMain.handle('companyDocuments:selectFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'jpg', 'png'] }] });
  return result.canceled ? null : result.filePaths[0];
});

// ===== ACCOUNTS & BANKING HANDLERS =====
ipcMain.handle('accounts:add', async (event, data) => {
  await ensureDbReady();
  try { return db.addAccount(data); } catch (err) { console.error('accounts:add', err); return { success: false, error: err.message }; }
});

ipcMain.handle('accounts:getAll', async () => {
  await ensureDbReady();
  try { return db.getAccounts(); } catch (err) { console.error('accounts:getAll', err); return []; }
});

ipcMain.handle('accounts:update', async (event, id, data) => {
  await ensureDbReady();
  try { return db.updateAccount(id, data); } catch (err) { console.error('accounts:update', err); return { success: false, error: err.message }; }
});

ipcMain.handle('accounts:delete', async (event, id) => {
  await ensureDbReady();
  try { return db.deleteAccount(id); } catch (err) { console.error('accounts:delete', err); return { success: false, error: err.message }; }
});

ipcMain.handle('accounts:updateBalance', async (event, accountId, amount, add) => {
  await ensureDbReady();
  try { return db.updateAccountBalance(accountId, amount, add); } catch (err) { console.error('accounts:updateBalance', err); return { success: false, error: err.message }; }
});

// ===== TRANSACTIONS HANDLERS =====
ipcMain.handle('transactions:add', async (event, data) => {
  await ensureDbReady();
  try { return db.addTransaction(data); } catch (err) { console.error('transactions:add', err); return { success: false, error: err.message }; }
});

ipcMain.handle('transactions:getAll', async (event, limit) => {
  await ensureDbReady();
  try { return db.getTransactions(limit); } catch (err) { console.error('transactions:getAll', err); return []; }
});

ipcMain.handle('transactions:getByLoan', async (event, loanId) => {
  await ensureDbReady();
  try { return db.getTransactionsByLoan(loanId); } catch (err) { console.error('transactions:getByLoan', err); return []; }
});

// ===== BACKUP HANDLERS =====
ipcMain.handle('backup:create', async (event, type) => {
  await ensureDbReady();
  try { return db.createBackup(type); } catch (err) { console.error('backup:create', err); return { success: false, error: err.message }; }
});

ipcMain.handle('backup:getAll', async () => {
  await ensureDbReady();
  try { return db.getBackups(); } catch (err) { console.error('backup:getAll', err); return []; }
});

ipcMain.handle('backup:restore', async (event, backupId) => {
  await ensureDbReady();
  try { 
    const result = db.restoreBackup(backupId);
    // Reinitialize DB after restore
    if (result.success) {
      dbReady = false;
      await ensureDbReady();
    }
    return result;
  } catch (err) { console.error('backup:restore', err); return { success: false, error: err.message }; }
});

ipcMain.handle('backup:deleteBackup', async (event, backupId) => {
  await ensureDbReady();
  try { return db.deleteBackup(backupId); } catch (err) { console.error('backup:deleteBackup', err); return { success: false, error: err.message }; }
});

// ===== BACKUP SCHEDULING HANDLERS =====
ipcMain.handle('backup:getSchedulingSettings', async () => {
  try {
    const settings = config.getBackupSettings();
    return {
      success: true,
      enabled: settings.enabled,
      frequency: settings.frequency,
      retentionDays: settings.retentionDays,
      maxBackups: settings.maxBackups
    };
  } catch (err) {
    console.error('backup:getSchedulingSettings', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('backup:updateSchedulingSettings', async (event, settings) => {
  try {
    const updated = config.setBackupSettings(settings);
    // Restart scheduler if enabled
    if (settings.enabled && backupScheduler) {
      backupScheduler.stop();
      backupScheduler.start();
    } else if (!settings.enabled && backupScheduler) {
      backupScheduler.stop();
    }
    return { success: true, settings: config.getBackupSettings() };
  } catch (err) {
    console.error('backup:updateSchedulingSettings', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('backup:getNextScheduledTime', async () => {
  try {
    const settings = config.getBackupSettings();
    if (!settings.enabled) {
      return { next: null };
    }
    const nextTime = config.getNextBackupTime(settings.frequency);
    return { next: nextTime.toISOString() };
  } catch (err) {
    console.error('backup:getNextScheduledTime', err);
    return { next: null, error: err.message };
  }
});

// ===== BALANCE SHEET HANDLERS =====
ipcMain.handle('balanceSheet:generate', async (event, period) => {
  await ensureDbReady();
  try { return db.generateBalanceSheet(period); } catch (err) { console.error('balanceSheet:generate', err); return { success: false, error: err.message }; }
});

ipcMain.handle('balanceSheet:getAll', async (event, limit) => {
  await ensureDbReady();
  try { return db.getBalanceSheets(limit); } catch (err) { console.error('balanceSheet:getAll', err); return []; }
});

ipcMain.handle('balanceSheet:delete', async (event, id) => {
  await ensureDbReady();
  try {
    db.exec(`DELETE FROM balance_sheets WHERE id = ?`, [id]);
    db.logAudit('DELETE', 'balance_sheet', id, null, null);
    db.setSetting('temp', 'trigger_save'); // Trigger save
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// ===== FILE MANAGEMENT HANDLERS =====

// Read file as base64 for embedding in documents
ipcMain.handle('files:readAsBase64', async (event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' };
    }
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');
    return { success: true, data: base64 };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('files:saveToClientFolder', async (event, clientNumber, clientName, subfolder, filename, base64Data) => {
  try {
    const clientFolder = getClientFolder(clientNumber, clientName);
    const targetFolder = path.join(clientFolder, subfolder);
    if (!fs.existsSync(targetFolder)) {
      fs.mkdirSync(targetFolder, { recursive: true });
    }
    const filePath = path.join(targetFolder, filename);
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, buffer);
    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('files:openClientFolder', async (event, clientNumber, clientName) => {
  try {
    const clientFolder = getClientFolder(clientNumber, clientName);
    if (fs.existsSync(clientFolder)) {
      require('electron').shell.openPath(clientFolder);
      return { success: true };
    }
    return { success: false, error: 'Folder not found' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('files:moveLoan', async (event, clientNumber, clientName, loanNumber, fromStatus, toStatus) => {
  return moveLoanFile(clientNumber, clientName, loanNumber, fromStatus, toStatus);
});

ipcMain.handle('files:uploadClientPhoto', async (event, clientNumber, clientName) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif'] }]
    });
    if (result.canceled) return null;
    
    const sourcePath = result.filePaths[0];
    const clientFolder = getClientFolder(clientNumber, clientName);
    const ext = path.extname(sourcePath);
    const targetPath = path.join(clientFolder, `profile_photo${ext}`);
    fs.copyFileSync(sourcePath, targetPath);
    return { success: true, filePath: targetPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
ipcMain.handle('files:selectCSV', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'CSV Files', extensions: ['csv', 'txt'] }]
    });
    if (result.canceled) return null;
    const content = fs.readFileSync(result.filePaths[0], 'utf8');
    return { success: true, content, filePath: result.filePaths[0] };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// List files in a client folder
ipcMain.handle('files:listClientFiles', async (event, clientNumber, clientName, subfolder = '') => {
  try {
    const clientFolder = getClientFolder(clientNumber, clientName);
    const targetFolder = subfolder ? path.join(clientFolder, subfolder) : clientFolder;
    
    if (!fs.existsSync(targetFolder)) {
      return { success: true, files: [], folders: [] };
    }
    
    const items = fs.readdirSync(targetFolder, { withFileTypes: true });
    const files = [];
    const folders = [];
    
    for (const item of items) {
      const fullPath = path.join(targetFolder, item.name);
      const stats = fs.statSync(fullPath);
      
      if (item.isDirectory()) {
        folders.push({
          name: item.name,
          path: path.join(subfolder || '', item.name)
        });
      } else {
        files.push({
          name: item.name,
          path: fullPath,
          size: stats.size,
          modified: stats.mtime,
          extension: path.extname(item.name).toLowerCase()
        });
      }
    }
    
    return { success: true, files, folders };
  } catch (err) {
    return { success: false, error: err.message, files: [], folders: [] };
  }
});

// Get client folder structure overview
ipcMain.handle('files:getClientFolderOverview', async (event, clientNumber, clientName) => {
  try {
    const clientFolder = getClientFolder(clientNumber, clientName);
    ensureClientFolderStructure(clientFolder);
    
    const overview = {
      rootPath: clientFolder,
      structure: {}
    };
    
    // Count files in each subfolder
    const countFiles = (dir) => {
      if (!fs.existsSync(dir)) return 0;
      return fs.readdirSync(dir).filter(f => {
        const fp = path.join(dir, f);
        return fs.existsSync(fp) && fs.statSync(fp).isFile();
      }).length;
    };
    
    overview.structure = {
      'loans/pending': countFiles(path.join(clientFolder, 'loans', 'pending')),
      'loans/cleared': countFiles(path.join(clientFolder, 'loans', 'cleared')),
      'loans/agreements': countFiles(path.join(clientFolder, 'loans', 'agreements')),
      'collateral/images': countFiles(path.join(clientFolder, 'collateral', 'images')),
      'collateral/documents': countFiles(path.join(clientFolder, 'collateral', 'documents')),
      'documents/identity': countFiles(path.join(clientFolder, 'documents', 'identity')),
      'documents/business': countFiles(path.join(clientFolder, 'documents', 'business')),
      'documents/other': countFiles(path.join(clientFolder, 'documents', 'other')),
      'signatures': countFiles(path.join(clientFolder, 'signatures')),
      'profile': countFiles(path.join(clientFolder, 'profile'))
    };
    
    overview.totalFiles = Object.values(overview.structure).reduce((a, b) => a + b, 0);
    
    return { success: true, ...overview };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ===== MIGRATION & DATA MANAGEMENT HANDLERS =====
ipcMain.handle('migration:analyzeDirectory', async (event, dirPath) => {
  try {
    if (!migrationManager) {
      initMigrationManager();
    }
    return migrationManager.analyzeDirectory(dirPath);
  } catch (err) {
    console.error('migration:analyzeDirectory', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('migration:findCandidates', async () => {
  try {
    if (!migrationManager) {
      initMigrationManager();
    }
    const candidates = migrationManager.findMigrationCandidates();
    return { success: true, candidates };
  } catch (err) {
    console.error('migration:findCandidates', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('migration:migrateData', async (event, sourcePath, destinationPath) => {
  try {
    if (!migrationManager) {
      initMigrationManager();
    }
    const result = await migrationManager.migrateData(sourcePath, destinationPath);
    return result;
  } catch (err) {
    console.error('migration:migrateData', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('migration:getProgress', async () => {
  try {
    if (!migrationManager) {
      return { current: 0, total: 0, percentage: 0, status: 'idle', message: '' };
    }
    return migrationManager.getProgress();
  } catch (err) {
    return { current: 0, total: 0, percentage: 0, status: 'error', message: err.message };
  }
});

ipcMain.handle('migration:verifyMigration', async (event, sourcePath, destinationPath) => {
  try {
    if (!migrationManager) {
      initMigrationManager();
    }
    return migrationManager.verifyMigration(sourcePath, destinationPath);
  } catch (err) {
    console.error('migration:verifyMigration', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('migration:exportData', async (event, exportPath, options) => {
  try {
    if (!migrationManager) {
      initMigrationManager();
    }
    return await migrationManager.exportData(exportPath, options);
  } catch (err) {
    console.error('migration:exportData', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('migration:importData', async (event, importPath) => {
  try {
    if (!migrationManager) {
      initMigrationManager();
    }
    const result = await migrationManager.importData(importPath);
    if (result.success) {
      // Re-initialize DB after import
      dbReady = false;
      await ensureDbReady();
    }
    return result;
  } catch (err) {
    console.error('migration:importData', err);
    return { success: false, error: err.message };
  }
});
// ===== COLLATERAL ENHANCED MANAGEMENT HANDLERS =====
ipcMain.handle('collateral:getMetadata', async (event, collateralId) => {
  try {
    if (!collateralManager) initCollateralManager();
    return collateralManager.getCollateralMetadata(collateralId);
  } catch (err) {
    console.error('collateral:getMetadata', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('collateral:getWithDetails', async (event, collateralId) => {
  try {
    if (!collateralManager) initCollateralManager();
    return collateralManager.getCollateralWithDetails(collateralId);
  } catch (err) {
    console.error('collateral:getWithDetails', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('collateral:generateReport', async (event, filters) => {
  try {
    if (!collateralManager) initCollateralManager();
    return collateralManager.generateCollateralReport(filters);
  } catch (err) {
    console.error('collateral:generateReport', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('collateral:bulkUpdateValuations', async (event, updates) => {
  try {
    if (!collateralManager) initCollateralManager();
    const result = collateralManager.bulkUpdateValuations(updates);
    return result;
  } catch (err) {
    console.error('collateral:bulkUpdateValuations', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('collateral:exportData', async (event, format) => {
  try {
    if (!collateralManager) initCollateralManager();
    return collateralManager.exportCollateralData(format);
  } catch (err) {
    console.error('collateral:exportData', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('collateral:getValuationHistory', async (event, collateralId) => {
  try {
    if (!collateralManager) initCollateralManager();
    const history = collateralManager.getValuationHistory(collateralId);
    return { success: true, ...history };
  } catch (err) {
    console.error('collateral:getValuationHistory', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('collateral:calculateDepreciation', async (event, collateralId) => {
  try {
    if (!collateralManager) initCollateralManager();
    const allCollateral = db.getAllCollateral();
    const collateral = allCollateral.find(c => c.id === collateralId);
    if (!collateral) {
      return { success: false, error: 'Collateral not found' };
    }
    return { success: true, depreciation: collateralManager.calculateDepreciation(collateral) };
  } catch (err) {
    console.error('collateral:calculateDepreciation', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('collateral:assessRisk', async (event, collateralId) => {
  try {
    if (!collateralManager) initCollateralManager();
    const allCollateral = db.getAllCollateral();
    const collateral = allCollateral.find(c => c.id === collateralId);
    if (!collateral) {
      return { success: false, error: 'Collateral not found' };
    }
    return { success: true, risk: collateralManager.assessCollateralRisk(collateral) };
  } catch (err) {
    console.error('collateral:assessRisk', err);
    return { success: false, error: err.message };
  }
});

// ===== EXPENSE TRACKER =====
ipcMain.handle('expenses:add', async (event, data) => {
  await ensureDbReady();
  try { return db.addExpense(data); } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('expenses:update', async (event, id, data) => {
  await ensureDbReady();
  try { return db.updateExpense(id, data); } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('expenses:delete', async (event, id) => {
  await ensureDbReady();
  try { return db.deleteExpense(id); } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('expenses:get', async (event, fromDate, toDate) => {
  await ensureDbReady();
  try { return db.getExpenses(fromDate, toDate); } catch (e) { return []; }
});

ipcMain.handle('expenses:selectReceipt', async (event, expenseId) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Receipt',
      properties: ['openFile'],
      filters: [{ name: 'Documents & Images', extensions: ['jpg', 'jpeg', 'png', 'pdf', 'gif', 'bmp'] }]
    });
    if (result.canceled || !result.filePaths.length) return null;
    const sourcePath = result.filePaths[0];
    const receiptsDir = path.join(config.getDataDirectory(), 'data', 'receipts');
    if (!fs.existsSync(receiptsDir)) fs.mkdirSync(receiptsDir, { recursive: true });
    const ext = path.extname(sourcePath);
    const filename = `receipt_${expenseId}_${Date.now()}${ext}`;
    const targetPath = path.join(receiptsDir, filename);
    fs.copyFileSync(sourcePath, targetPath);
    return { success: true, filePath: targetPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('files:openPath', async (event, filePath) => {
  try {
    const { shell } = require('electron');
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'File not found' };
    await shell.openPath(filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('files:openWith', async (event, filePath) => {
  try {
    const { spawn } = require('child_process');
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'File not found' };
    const escaped = filePath.replace(/\\/g, '\\\\');
    spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `(New-Object -Com Shell.Application).ShellExecute('${escaped}', '', '', 'open', 0); Start-Sleep -Milliseconds 500`
    ], { detached: true, windowsHide: false });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ===== EXPENSE ATTACHMENTS (v2.5.0) =====
ipcMain.handle('expenses:selectFiles', async (event, expenseId) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Files to Attach',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All Supported', extensions: ['jpg','jpeg','png','gif','bmp','webp','pdf','mp4','mov','avi','webm','mkv','doc','docx','xls','xlsx','txt','csv'] },
        { name: 'Images', extensions: ['jpg','jpeg','png','gif','bmp','webp'] },
        { name: 'Documents', extensions: ['pdf','doc','docx','xls','xlsx','txt','csv'] },
        { name: 'Videos', extensions: ['mp4','mov','avi','webm','mkv'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
    const attachmentsDir = path.join(config.getDataDirectory(), 'data', 'expense_attachments');
    if (!fs.existsSync(attachmentsDir)) fs.mkdirSync(attachmentsDir, { recursive: true });
    const saved = [];
    for (const sourcePath of result.filePaths) {
      const ext = path.extname(sourcePath).toLowerCase();
      const originalName = path.basename(sourcePath);
      const safeName = `exp${expenseId}_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`;
      const targetPath = path.join(attachmentsDir, safeName);
      fs.copyFileSync(sourcePath, targetPath);
      const stat = fs.statSync(targetPath);
      let fileType = 'other';
      if (['.jpg','.jpeg','.png','.gif','.bmp','.webp'].includes(ext)) fileType = 'image';
      else if (ext === '.pdf') fileType = 'pdf';
      else if (['.mp4','.mov','.avi','.webm','.mkv'].includes(ext)) fileType = 'video';
      else if (['.doc','.docx','.xls','.xlsx','.txt','.csv'].includes(ext)) fileType = 'document';
      saved.push({ filePath: targetPath, fileName: originalName, fileType, fileSize: stat.size, ext });
    }
    return { success: true, files: saved };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('expenses:addAttachment', async (event, expenseId, fileName, filePath, fileType, fileSize, caption) => {
  await ensureDbReady();
  try {
    return db.addExpenseAttachment(expenseId, fileName, filePath, fileType, fileSize, caption);
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('expenses:getAttachments', async (event, expenseId) => {
  await ensureDbReady();
  try { return db.getExpenseAttachments(expenseId); } catch (e) { return []; }
});

ipcMain.handle('expenses:getAttachmentCounts', async () => {
  await ensureDbReady();
  try { return db.getExpenseAttachmentCounts(); } catch (e) { return {}; }
});

ipcMain.handle('expenses:deleteAttachment', async (event, id) => {
  await ensureDbReady();
  try {
    const result = db.deleteExpenseAttachment(id);
    if (result.success && result.filePath && fs.existsSync(result.filePath)) {
      try { fs.unlinkSync(result.filePath); } catch (e) { /* ignore if already gone */ }
    }
    return result;
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('expenses:getWithAttachments', async (event, expenseId) => {
  await ensureDbReady();
  try { return db.getExpenseWithAttachments(expenseId); } catch (e) { return null; }
});

ipcMain.handle('expenses:downloadAttachment', async (event, filePath, suggestedName, autoDownload = false) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'File not found' };
    const os = require('os');
    let destPath;
    
    if (autoDownload) {
      // Auto-save to Downloads folder (like export CSV)
      const downloadsPath = path.join(os.homedir(), 'Downloads');
      if (!fs.existsSync(downloadsPath)) fs.mkdirSync(downloadsPath, { recursive: true });
      destPath = path.join(downloadsPath, suggestedName || path.basename(filePath));
      // Handle filename duplicates
      let counter = 1;
      const base = destPath;
      while (fs.existsSync(destPath)) {
        const ext = path.extname(base);
        const nameOnly = path.basename(base, ext);
        destPath = path.join(path.dirname(base), `${nameOnly} (${counter})${ext}`);
        counter++;
      }
    } else {
      // Show Save-As dialog
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Attachment',
        defaultPath: suggestedName || path.basename(filePath),
        filters: [{ name: 'All Files', extensions: ['*'] }]
      });
      if (result.canceled) return { success: false, canceled: true };
      destPath = result.filePath;
    }
    
    fs.copyFileSync(filePath, destPath);
    return { success: true, savedTo: destPath };
  } catch (err) { return { success: false, error: err.message }; }
});

// ===== LOAN TEMPLATES =====
ipcMain.handle('loanTemplates:get', async () => {
  await ensureDbReady();
  try { return db.getLoanTemplates(); } catch (e) { return []; }
});
ipcMain.handle('loanTemplates:save', async (event, templates) => {
  await ensureDbReady();
  try { return db.saveLoanTemplates(templates); } catch (e) { return { success: false, error: e.message }; }
});

// ===== LOAN META (officer, guarantor, purpose, restructure) =====
ipcMain.handle('loans:updateMeta', async (event, loanId, data) => {
  await ensureDbReady();
  try { return db.updateLoanMeta(loanId, data); } catch (e) { return { success: false, error: e.message }; }
});
