const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');

// Production constants
const BACKUP_RETENTION = 5;
const MAX_BACKUP_SIZE_MB = 100;
const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
const TEMP_WRITE_TIMEOUT = 5000; // 5 second timeout for atomic write

// Database save queue for handling rapid mutations
class SaveQueue {
  constructor() {
    this.pending = false;
    this.saving = false;
    this.queue = [];
    this.estimatedMemoryBytes = 0;
    this.MAX_QUEUE_MEMORY = 100 * 1024 * 1024; // 100MB cap
  }
  
  async enqueue(saveFunction) {
    // SECURITY: Prevent memory exhaustion from queue buildup
    if (this.estimatedMemoryBytes > this.MAX_QUEUE_MEMORY) {
      console.error('[SaveQueue] Memory limit exceeded, rejecting new save');
      throw new Error('Save queue memory limit exceeded');
    }
    
    if (this.saving) {
      this.pending = true;
      this.estimatedMemoryBytes += 1024; // Estimate 1KB per queued item
      
      if (this.estimatedMemoryBytes > this.MAX_QUEUE_MEMORY * 0.8) {
        console.warn('[SaveQueue] Approaching memory limit:', (this.estimatedMemoryBytes / 1024 / 1024).toFixed(2) + 'MB');
      }
      
      return new Promise((resolve, reject) => {
        this.queue.push({ resolve, reject });
      });
    }
    
    this.saving = true;
    try {
      await saveFunction();
      return true;
    } finally {
      this.saving = false;
      this.estimatedMemoryBytes = Math.max(0, this.estimatedMemoryBytes - 1024);
      
      if (this.pending && this.queue.length > 0) {
        this.pending = false;
        // Process queued saves
        const queued = this.queue.shift();
        this.enqueue(saveFunction)
          .then(queued.resolve)
          .catch(queued.reject);
      } else {
        this.pending = false;
      }
    }
  }
}

const saveQueue = new SaveQueue();

let dataDir = path.join(__dirname, 'data');
let dbPath = path.join(dataDir, 'migl360.db');
let backupDir = path.join(dataDir, 'backups');
let logsDir = path.join(dataDir, 'logs');

let db = null;
let SQL = null;
let lastSaveTime = 0;
let isSaving = false;
let pendingSave = false;

async function initDB(userDataPath) {
  if (userDataPath) {
    dataDir = path.join(userDataPath, 'data');
    dbPath = path.join(dataDir, 'migl360.db');
  }
  
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!SQL) SQL = await initSqlJs();
  
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  
  // Initialize schema
  db.run(`CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, clientNumber TEXT UNIQUE, name TEXT NOT NULL, phone TEXT, nrc TEXT, email TEXT, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS loans (id INTEGER PRIMARY KEY AUTOINCREMENT, loanNumber TEXT UNIQUE, clientId INTEGER NOT NULL, amount REAL NOT NULL, interest REAL DEFAULT 0, paidAmount REAL DEFAULT 0, loanDate TEXT, dueDate TEXT, status TEXT DEFAULT 'pending', notes TEXT, collateral TEXT, collateralValue REAL DEFAULT 0, signatureData TEXT, signingDate TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(clientId) REFERENCES clients(id) ON DELETE CASCADE)`);
  db.run(`CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, loanId INTEGER NOT NULL, amount REAL NOT NULL, paymentDate TEXT, notes TEXT, FOREIGN KEY(loanId) REFERENCES loans(id) ON DELETE CASCADE)`);
  db.run(`CREATE TABLE IF NOT EXISTS penalties (id INTEGER PRIMARY KEY AUTOINCREMENT, loanId INTEGER NOT NULL, amount REAL NOT NULL, reason TEXT, createdAt TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(loanId) REFERENCES loans(id) ON DELETE CASCADE)`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, entityType TEXT, entityId INTEGER, oldValue TEXT, newValue TEXT, timestamp TEXT DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_settings_key ON settings(key)`);
  // Expense tracker table
  db.run(`CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT DEFAULT 'General',
    expenseDate TEXT DEFAULT CURRENT_TIMESTAMP,
    payee TEXT,
    reference TEXT,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expenseDate)`);
  db.run(`CREATE TABLE IF NOT EXISTS client_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, clientId INTEGER NOT NULL, documentType TEXT NOT NULL, filePath TEXT NOT NULL, fileName TEXT NOT NULL, uploadDate TEXT DEFAULT CURRENT_TIMESTAMP, notes TEXT, FOREIGN KEY(clientId) REFERENCES clients(id) ON DELETE CASCADE)`);
  db.run(`CREATE TABLE IF NOT EXISTS company_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, documentType TEXT NOT NULL, filePath TEXT NOT NULL, fileName TEXT NOT NULL, uploadDate TEXT DEFAULT CURRENT_TIMESTAMP, notes TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, accountName TEXT NOT NULL UNIQUE, accountType TEXT NOT NULL, accountNumber TEXT, provider TEXT, balance REAL DEFAULT 0, isActive INTEGER DEFAULT 1, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, fromAccountId INTEGER, toAccountId INTEGER, amount REAL NOT NULL, transactionType TEXT, referenceType TEXT, referenceId INTEGER, description TEXT, transactionDate TEXT DEFAULT CURRENT_TIMESTAMP, notes TEXT, FOREIGN KEY(fromAccountId) REFERENCES accounts(id), FOREIGN KEY(toAccountId) REFERENCES accounts(id))`);
  db.run(`CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY AUTOINCREMENT, backupName TEXT NOT NULL, backupDate TEXT DEFAULT CURRENT_TIMESTAMP, backupData TEXT NOT NULL, backupType TEXT, notes TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS balance_sheets (id INTEGER PRIMARY KEY AUTOINCREMENT, sheetDate TEXT NOT NULL, period TEXT, totalAssets REAL, totalLiabilities REAL, totalEquity REAL, data TEXT, createdAt TEXT DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, passwordHash TEXT NOT NULL, salt TEXT NOT NULL, secQuestion TEXT, secAnswerHash TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS collateral (id INTEGER PRIMARY KEY AUTOINCREMENT, clientId INTEGER NOT NULL, loanId INTEGER NOT NULL, itemType TEXT NOT NULL, description TEXT, estimatedValue REAL NOT NULL, acceptedValue REAL, status TEXT DEFAULT 'active', imagePaths TEXT, documentPath TEXT, consentGiven INTEGER DEFAULT 0, consentDate TEXT, forfeitDate TEXT, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(clientId) REFERENCES clients(id) ON DELETE CASCADE, FOREIGN KEY(loanId) REFERENCES loans(id) ON DELETE CASCADE)`);
  
  // Schema version tracking table for migration history
  db.run(`CREATE TABLE IF NOT EXISTS schema_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    description TEXT,
    appliedAt TEXT DEFAULT CURRENT_TIMESTAMP,
    success INTEGER DEFAULT 1
  )`);
  
  // Track current schema version
  const CURRENT_SCHEMA_VERSION = '2.1.0';
  const schemaCheck = db.exec(`SELECT version FROM schema_versions ORDER BY id DESC LIMIT 1`);
  const currentVersion = schemaCheck[0]?.values[0]?.[0] || '0.0.0';
  if (currentVersion !== CURRENT_SCHEMA_VERSION) {
    db.run(`INSERT INTO schema_versions (version, description) VALUES (?, ?)`,
      [CURRENT_SCHEMA_VERSION, 'Security and performance improvements']);
    logProduction('SCHEMA_UPGRADE', { from: currentVersion, to: CURRENT_SCHEMA_VERSION });
  }
  
  // Migrations - with SQL injection prevention via whitelist
  // SECURITY: Whitelist of allowed tables and columns for migrations
  const ALLOWED_TABLES = ['clients', 'loans', 'payments', 'penalties', 'audit_log', 'settings', 
    'client_documents', 'company_documents', 'accounts', 'transactions', 'backups', 
    'balance_sheets', 'users', 'collateral', 'schema_versions', 'loan_installments', 'expenses'];
  const ALLOWED_COLUMN_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  
  function ensureColumn(table, column, typeDef) {
    try {
      // SECURITY: Validate table and column names against whitelist/pattern
      if (!ALLOWED_TABLES.includes(table)) {
        console.error('[DB] Migration blocked: Invalid table name:', table);
        return;
      }
      if (!ALLOWED_COLUMN_PATTERN.test(column)) {
        console.error('[DB] Migration blocked: Invalid column name:', column);
        return;
      }
      
      const info = db.exec(`PRAGMA table_info(${table})`);
      const exists = info[0]?.values?.some(row => String(row[1]).toLowerCase() === String(column).toLowerCase());
      if (!exists) {
        db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDef}`);
      }
    } catch (e) {
      try { console.warn('Migration:', table, column, e.message); } catch {}
    }
  }
  
  ensureColumn('clients', 'clientNumber', 'TEXT');
  // Extended client fields (v2.1.0)
  ensureColumn('clients', 'gender', 'TEXT');
  ensureColumn('clients', 'dateOfBirth', 'TEXT');
  ensureColumn('clients', 'phone2', 'TEXT');
  ensureColumn('clients', 'address', 'TEXT');
  ensureColumn('clients', 'occupation', 'TEXT');
  ensureColumn('clients', 'employer', 'TEXT');
  ensureColumn('clients', 'monthlyIncome', 'REAL');
  ensureColumn('clients', 'employmentStatus', 'TEXT');
  ensureColumn('clients', 'nokName', 'TEXT');
  ensureColumn('clients', 'nokRelation', 'TEXT');
  ensureColumn('clients', 'nokPhone', 'TEXT');
  // Enterprise client fields (v2.2.0 - World-Class Client Module)
  // Location
  ensureColumn('clients', 'nationality', 'TEXT');
  ensureColumn('clients', 'city', 'TEXT');
  ensureColumn('clients', 'country', 'TEXT DEFAULT "Zambia"');
  // Financial Profile
  ensureColumn('clients', 'incomeSource', 'TEXT');
  ensureColumn('clients', 'businessName', 'TEXT');
  // Risk & Credit
  ensureColumn('clients', 'creditScore', 'REAL DEFAULT 50');
  ensureColumn('clients', 'riskLevel', 'TEXT DEFAULT "medium"');
  // Client Status & System Intelligence
  ensureColumn('clients', 'clientStatus', 'TEXT DEFAULT "active"');
  ensureColumn('clients', 'blacklisted', 'INTEGER DEFAULT 0');
  ensureColumn('clients', 'lastActivity', 'TEXT');
  // KYC Compliance
  ensureColumn('clients', 'kycStatus', 'TEXT DEFAULT "pending"');
  ensureColumn('clients', 'kycVerifiedDate', 'TEXT');
  ensureColumn('clients', 'kycNotes', 'TEXT');
  // Profile Image
  ensureColumn('clients', 'profileImage', 'TEXT');
  ensureColumn('loans', 'loanNumber', 'TEXT');
  ensureColumn('loans', 'signatureData', 'TEXT');
  ensureColumn('loans', 'signingDate', 'TEXT');
  
  // ===== LOAN ENGINE COLUMNS (v2.3.0) =====
  ensureColumn('loans', 'loanType', 'TEXT DEFAULT "monthly"'); // weekly | monthly | bullet | custom
  ensureColumn('loans', 'duration', 'INTEGER DEFAULT 1'); // number of payment periods
  ensureColumn('loans', 'frequencyDays', 'INTEGER DEFAULT 30'); // days between payments
  ensureColumn('loans', 'totalPayable', 'REAL'); // amount + total interest
  ensureColumn('loans', 'installmentAmount', 'REAL'); // per-period payment
  ensureColumn('loans', 'remainingBalance', 'REAL'); // outstanding balance
  ensureColumn('loans', 'nextPaymentDate', 'TEXT'); // next expected payment
  ensureColumn('loans', 'missedPayments', 'INTEGER DEFAULT 0'); // count of missed payments
  ensureColumn('loans', 'daysOverdue', 'INTEGER DEFAULT 0'); // days past due
  ensureColumn('loans', 'riskLevel', 'TEXT DEFAULT "low"'); // low | medium | high | critical
  ensureColumn('loans', 'disbursementDate', 'TEXT'); // when money was given out
  ensureColumn('loans', 'agreementSigned', 'INTEGER DEFAULT 0'); // 1 if agreement signed
  
  // Early Settlement System columns
  ensureColumn('loans', 'earlySettlementEnabled', 'INTEGER DEFAULT 0'); // 1 if early settlement allowed
  ensureColumn('loans', 'earlySettlementRates', 'TEXT'); // JSON: { sameWeek: %, week1: %, week2: %, week3Plus: % }
  ensureColumn('loans', 'earlySettlementHistory', 'TEXT'); // JSON array of early settlement records
  ensureColumn('loans', 'settledEarly', 'INTEGER DEFAULT 0'); // 1 if loan was settled early
  ensureColumn('loans', 'settlementDate', 'TEXT'); // date when early settlement was applied
  ensureColumn('loans', 'settlementAmount', 'REAL'); // final amount paid for early settlement
  
  // Signature and Agreement columns  
  ensureColumn('loans', 'borrowerSignature', 'TEXT'); // base64 signature image
  ensureColumn('loans', 'lenderSignature', 'TEXT'); // base64 signature image
  ensureColumn('loans', 'agreementFilePath', 'TEXT'); // path to signed agreement PDF

  // New feature columns
  ensureColumn('loans', 'officerName', 'TEXT'); // assigned officer/field agent name
  ensureColumn('loans', 'loanPurpose', 'TEXT'); // purpose e.g. Business, Personal, Emergency
  ensureColumn('loans', 'guarantorName', 'TEXT'); // guarantor full name
  ensureColumn('loans', 'guarantorPhone', 'TEXT'); // guarantor phone
  ensureColumn('loans', 'guarantorRelation', 'TEXT'); // relationship to borrower
  ensureColumn('loans', 'restructured', 'INTEGER DEFAULT 0'); // 1 if loan has been restructured
  ensureColumn('loans', 'restructureNotes', 'TEXT'); // restructure history (JSON array)
  ensureColumn('loans', 'templateId', 'TEXT'); // loan template ID that was used
  
  // ===== EXPENSE TRACKER COLUMNS (v2.4.0) =====
  ensureColumn('expenses', 'tags', 'TEXT'); // comma-separated tags for filtering/grouping
  ensureColumn('expenses', 'receiptPath', 'TEXT'); // path to attached receipt image/PDF (legacy single)

  // ===== EXPENSE ATTACHMENTS TABLE (v2.5.0) =====
  db.run(`CREATE TABLE IF NOT EXISTS expense_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    expenseId INTEGER NOT NULL,
    fileName TEXT NOT NULL,
    filePath TEXT NOT NULL,
    fileType TEXT,
    fileSize INTEGER,
    caption TEXT,
    uploadDate TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(expenseId) REFERENCES expenses(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_exp_attachments_expense ON expense_attachments(expenseId)`);
  
  // Loan Installments table (payment schedule)
  db.run(`CREATE TABLE IF NOT EXISTS loan_installments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loanId INTEGER NOT NULL,
    installmentNumber INTEGER NOT NULL,
    dueDate TEXT NOT NULL,
    amount REAL NOT NULL,
    principalPortion REAL,
    interestPortion REAL,
    paidAmount REAL DEFAULT 0,
    paidDate TEXT,
    status TEXT DEFAULT 'pending',
    lateFee REAL DEFAULT 0,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(loanId) REFERENCES loans(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_installments_loanId ON loan_installments(loanId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_installments_dueDate ON loan_installments(dueDate)`);
  
  ensureColumn('collateral', 'forfeitDate', 'TEXT');
  ensureColumn('collateral', 'acceptedValue', 'REAL');
  ensureColumn('collateral', 'documentPath', 'TEXT');
  ensureColumn('collateral', 'imagePaths', 'TEXT');
  ensureColumn('collateral', 'consentGiven', 'INTEGER DEFAULT 0');
  ensureColumn('collateral', 'consentDate', 'TEXT');
  ensureColumn('collateral', 'notes', 'TEXT');
  ensureColumn('collateral', 'description', 'TEXT');
  ensureColumn('users', 'secQuestion', 'TEXT');
  ensureColumn('users', 'secAnswerHash', 'TEXT');
  ensureColumn('users', 'role', 'TEXT DEFAULT "user"');
  ensureColumn('users', 'permissions', 'TEXT DEFAULT "read,write"');
  ensureColumn('users', 'isActive', 'INTEGER DEFAULT 1');
  ensureColumn('users', 'lastLogin', 'TEXT');
  
  // ===== PAYMENTS MODULE UPGRADE (v2.4.0) =====
  // Enhanced payment tracking columns
  ensureColumn('payments', 'receiptNumber', 'TEXT'); // Auto-generated receipt ID
  ensureColumn('payments', 'paymentMethod', 'TEXT DEFAULT "cash"'); // cash, bank_transfer, mobile_money, cheque, card
  ensureColumn('payments', 'referenceNumber', 'TEXT'); // Transaction/cheque reference
  ensureColumn('payments', 'status', 'TEXT DEFAULT "completed"'); // completed, pending, reversed, voided
  ensureColumn('payments', 'principalPortion', 'REAL DEFAULT 0'); // Allocated to principal
  ensureColumn('payments', 'interestPortion', 'REAL DEFAULT 0'); // Allocated to interest
  ensureColumn('payments', 'penaltyPortion', 'REAL DEFAULT 0'); // Allocated to penalties
  ensureColumn('payments', 'feePortion', 'REAL DEFAULT 0'); // Allocated to fees
  ensureColumn('payments', 'receivedBy', 'TEXT'); // Staff who processed
  ensureColumn('payments', 'paymentChannel', 'TEXT'); // branch, mobile_app, web, agent
  ensureColumn('payments', 'reversedAt', 'TEXT'); // Reversal timestamp
  ensureColumn('payments', 'reversedBy', 'TEXT'); // Who reversed
  ensureColumn('payments', 'reversalReason', 'TEXT'); // Reason for reversal
  ensureColumn('payments', 'createdAt', 'TEXT');
  ensureColumn('payments', 'updatedAt', 'TEXT');
  ensureColumn('payments', 'clientId', 'INTEGER'); // Denormalized for faster queries
  ensureColumn('payments', 'installmentId', 'INTEGER'); // Link to specific installment
  
  // Payment Promise feature (v2.4.1)
  ensureColumn('payments', 'promiseDate', 'TEXT'); // Expected payment date commitment
  ensureColumn('payments', 'promiseAmount', 'REAL'); // Promised payment amount
  ensureColumn('payments', 'promiseNotes', 'TEXT'); // Notes for payment promise
  ensureColumn('payments', 'promiseStatus', 'TEXT'); // pending, fulfilled, broken, cancelled
  
  // Penalties tracking enhancements
  ensureColumn('penalties', 'status', 'TEXT DEFAULT "active"'); // active, paid, waived
  ensureColumn('penalties', 'paidAmount', 'REAL DEFAULT 0');
  ensureColumn('penalties', 'paidDate', 'TEXT');
  ensureColumn('penalties', 'waivedBy', 'TEXT');
  ensureColumn('penalties', 'waivedAt', 'TEXT');
  ensureColumn('penalties', 'penaltyType', 'TEXT DEFAULT "late_payment"'); // late_payment, bounced_cheque, early_termination, other
  
  // Create indexes for payment analytics
  db.run(`CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(paymentDate)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(paymentMethod)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payments_clientId ON payments(clientId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_penalties_status ON penalties(status)`);
  
  // Create indexes for foreign keys (performance optimization)
  db.run(`CREATE INDEX IF NOT EXISTS idx_loans_clientId ON loans(clientId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payments_loanId ON payments(loanId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_penalties_loanId ON penalties(loanId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_collateral_loanId ON collateral(loanId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_collateral_clientId ON collateral(clientId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_client_documents_clientId ON client_documents(clientId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_log_entityType_entityId ON audit_log(entityType, entityId)`);
  
  // CRITICAL: Enable foreign key enforcement
  db.run(`PRAGMA foreign_keys = ON`);
  
  // Verify DB integrity on startup
  const integrityCheck = verifyDBIntegrity();
  if (!integrityCheck.valid) {
    logProduction('DB_INTEGRITY_WARNING', { details: integrityCheck });
    console.warn('[DB] Integrity check warning:', integrityCheck.reason || integrityCheck.details);
  }
  
  saveDB();
}

// Debounced save - prevents rapid consecutive saves from blocking UI
let saveDebounceTimer = null;
const SAVE_DEBOUNCE_MS = 100; // Batch saves within 100ms

function saveDB() {
  if (!db) return;
  
  // Clear existing timer and set a new one (debounce)
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
  }
  
  saveDebounceTimer = setTimeout(() => {
    saveDBImmediate();
  }, SAVE_DEBOUNCE_MS);
}

// Force immediate save (used for critical operations)
function saveDBImmediate() {
  if (!db || isSaving) {
    if (!isSaving) pendingSave = true;
    return;
  }
  
  isSaving = true;
  
  // Use setImmediate to yield to event loop, preventing UI freeze
  setImmediate(() => {
    try {
      const data = db.export();
      const buffer = Buffer.from(data);
      
      // Atomic write: write to temp, fsync, then rename
      const tempPath = dbPath + '.tmp';
      const backupPath = dbPath + '.bak';
      
      try {
        fs.writeFileSync(tempPath, buffer);
        
        // fsync can be slow - skip for small DBs or use async
        if (buffer.length > 1024 * 1024) { // Only fsync for DBs > 1MB
          try {
            const fd = fs.openSync(tempPath, 'r+');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
          } catch (e) {
            // fsync failure is non-critical for small DBs
          }
        }
        
        // Rotate backup (deferred to not block)
        if (fs.existsSync(dbPath)) {
          fs.copyFileSync(dbPath, backupPath);
          // Defer rolling backup to avoid blocking
          setImmediate(() => createRollingBackup(dbPath));
        }
        
        // Atomic rename
        fs.renameSync(tempPath, dbPath);
        lastSaveTime = Date.now();
        // Defer logging to avoid blocking
        setImmediate(() => logProduction('DB_SAVED', { size: buffer.length, timestamp: new Date().toISOString() }));
      } catch (err) {
        logProduction('DB_SAVE_ERROR', { error: err.message });
        if (fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch (e) {}
        }
        throw err;
      }
    } finally {
      isSaving = false;
      if (pendingSave) {
        pendingSave = false;
        // Defer pending save to yield to event loop
        setImmediate(() => saveDB());
      }
    }
  });
}

function createRollingBackup(sourcePath) {
  try {
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const backupName = `migl_${timestamp}.db.bak`;
    const backupPath = path.join(backupDir, backupName);
    
    fs.copyFileSync(sourcePath, backupPath);
    
    // Prune old backups (keep last N)
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('migl_') && f.endsWith('.db.bak'))
      .map(f => ({
        name: f,
        path: path.join(backupDir, f),
        time: fs.statSync(path.join(backupDir, f)).mtime
      }))
      .sort((a, b) => b.time - a.time);
    
    files.slice(BACKUP_RETENTION).forEach(f => {
      try { fs.unlinkSync(f.path); } catch (e) {}
    });
    
    logProduction('BACKUP_CREATED', { backup: backupName, totalBackups: files.length });
  } catch (err) {
    logProduction('BACKUP_ERROR', { error: err.message });
  }
}

function verifyDBIntegrity() {
  try {
    if (!db) return { valid: false, reason: 'DB not loaded' };
    const result = db.exec('PRAGMA integrity_check');
    const valid = result[0]?.values?.[0]?.[0] === 'ok';
    if (!valid) logProduction('DB_INTEGRITY_CHECK_FAILED', result);
    return { valid, details: result[0]?.values?.[0]?.[0] };
  } catch (err) {
    return { valid: false, reason: err.message };
  }
}

function logProduction(action, data = {}) {
  try {
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, 'migl-production.log');
    const entry = JSON.stringify({ 
      timestamp: new Date().toISOString(), 
      action, 
      ...data 
    }) + '\n';
    fs.appendFileSync(logFile, entry);
    
    // Rotate log if > 10MB
    try {
      const stat = fs.statSync(logFile);
      if (stat.size > 10 * 1024 * 1024) {
        const rotated = logFile + '.' + Date.now();
        fs.renameSync(logFile, rotated);
      }
    } catch (e) {}
  } catch (err) {
    console.error('[LOG_ERROR]', err.message);
  }
}

function execSQL(sql, params = []) {
  if (!db) throw new Error('Database not initialized');
  try {
    if (!params || params.length === 0) {
      return db.exec(sql);
    }
    const stmt = db.prepare(sql);
    if (params && params.length) stmt.bind(params);
    const columns = stmt.getColumnNames ? stmt.getColumnNames() : [];
    const values = [];
    while (stmt.step()) {
      values.push(stmt.get());
    }
    stmt.free();
    return [{ columns, values }];
  } catch (e) {
    try { return db.exec(sql); } catch (e2) { throw e2; }
  }
}

// Async password hashing with bcrypt (10 rounds)
async function hashPasswordBcrypt(password) {
  return new Promise((resolve, reject) => {
    bcrypt.hash(password, 10, (err, hash) => {
      if (err) reject(err);
      else resolve(hash);
    });
  });
}

// Verify password against bcrypt hash
async function verifyPassword(password, hash) {
  return new Promise((resolve, reject) => {
    bcrypt.compare(password, hash, (err, isMatch) => {
      if (err) reject(err);
      else resolve(isMatch);
    });
  });
}

// Legacy support: hash password with SHA256 (for migration)
function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(`${password}:${salt}`).digest('hex');
}

function logAudit(action, entityType, entityId, oldVal, newVal) {
  db.run(`INSERT INTO audit_log (action, entityType, entityId, oldValue, newValue) VALUES (?, ?, ?, ?, ?)`,
    [action, entityType, entityId, oldVal, newVal]);
  saveDB();
}

function getSetting(key) {
  const res = db.exec(`SELECT value FROM settings WHERE key = ?`, [key]);
  return res[0]?.values[0]?.[0] || null;
}

function getCompanyInitials() {
  const manual = getSetting('companyInitials');
  if (manual && manual.trim().length > 0) return manual.trim().toUpperCase();
  const companyName = getSetting('companyName') || 'MIG';
  if (companyName === 'MIG') return 'MIG';
  const initials = companyName
    .split(/\s+/)
    .map(word => word[0])
    .join('')
    .substring(0, 3)
    .toUpperCase();
  return initials || 'MIG';
}

function generateClientNumber() {
  const initials = getCompanyInitials();
  const res = db.exec(`SELECT COUNT(*) as count FROM clients`);
  const count = (res[0]?.values[0]?.[0] || 0) + 1;
  return `${initials}-${String(count).padStart(4, '0')}`;
}

function generateLoanNumber() {
  const initials = getCompanyInitials();
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = String(now.getFullYear()).slice(-2);
  const monthYear = month + year;
  const res = db.exec(`SELECT COUNT(*) as count FROM loans`);
  const count = (res[0]?.values[0]?.[0] || 0) + 1;
  return `${initials}-${monthYear}-L${String(count).padStart(5, '0')}`;
}

function today() {
  return new Date().toISOString().split('T')[0];
}

// Improved transaction wrapper with async support and automatic audit logging
function withTransaction(operations) {
  try {
    db.run('BEGIN TRANSACTION');
    const result = operations();
    db.run('COMMIT');
    saveDB();
    return { success: true, ...result };
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[DB] Rollback failed:', rollbackErr.message);
    }
    throw err;
  }
}

// Async transaction wrapper for operations that need await
async function withTransactionAsync(operations) {
  try {
    db.run('BEGIN TRANSACTION');
    const result = await operations();
    db.run('COMMIT');
    saveDB();
    return { success: true, ...result };
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[DB] Rollback failed:', rollbackErr.message);
    }
    throw err;
  }
}

// Audit-included transaction (audit log is part of the transaction)
function withAuditTransaction(action, entityType, entityId, oldVal, newVal, operations) {
  return withTransaction(() => {
    const result = operations();
    // Audit log is now part of the transaction
    db.run(`INSERT INTO audit_log (action, entityType, entityId, oldValue, newValue) VALUES (?, ?, ?, ?, ?)`,
      [action, entityType, entityId, oldVal, newVal]);
    return result;
  });
}

function getMachineId() {
  try {
    const os = require('os');
    const cpus = os.cpus();
    const hostname = os.hostname();
    const platform = os.platform();
    const release = os.release();
    const fingerprint = `${hostname}:${platform}:${release}:${cpus[0].model}`;
    // SECURITY: Use SHA256 instead of MD5
    const hash = crypto.createHash('sha256').update(fingerprint).digest('hex');
    return `${hash.substring(0,4)}-${hash.substring(4,8)}-${hash.substring(8,12)}-${hash.substring(12,16)}`.toUpperCase();
  } catch (err) {
    console.error('Error getting machine ID:', err);
    return 'UNKNOWN';
  }
}

// SECURITY: License secret from environment or secure default (warn if default used)
const LICENSE_SECRET = process.env.MIG_LICENSE_SECRET || 'MIG_SECRET_2026_SECURE_RANDOM_STRING_DEFAULT';
if (!process.env.MIG_LICENSE_SECRET) {
  console.warn('[SECURITY] MIG_LICENSE_SECRET environment variable not set. Using default salt.');
}

function generateLicenseHash(machineId, expiryDate) {
  const data = `${machineId}:${expiryDate}:${LICENSE_SECRET}`;
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 20).toUpperCase();
}

function validateLicense(licenseKey) {
  try {
    if (!licenseKey || typeof licenseKey !== 'string') {
      return { valid: false, error: 'Invalid license format' };
    }
    
    const parts = licenseKey.split('-');
    if (parts.length !== 4 || parts[0] !== 'MIG') {
      return { valid: false, error: 'Invalid license format' };
    }
    
    const machineId = getMachineId();
    const machinePart = machineId.substring(0, 4);
    
    if (parts[1] !== machinePart) {
      return { valid: false, error: 'License not valid for this computer' };
    }
    
    const expiryPart = parts[2];
    if (expiryPart.length !== 6) {
      return { valid: false, error: 'Invalid license date format' };
    }
    
    const year = 2000 + parseInt(expiryPart.substring(0, 2), 10);
    const month = parseInt(expiryPart.substring(2, 4), 10) - 1;
    const day = parseInt(expiryPart.substring(4, 6), 10);
    
    if (isNaN(year) || isNaN(month) || isNaN(day)) {
      return { valid: false, error: 'Invalid license date' };
    }
    
    const expiryDate = new Date(year, month, day, 23, 59, 59); // End of expiry day
    
    // Use server time for validation (prevent local time manipulation)
    const currentDate = new Date();
    if (expiryDate < currentDate) {
      return { valid: false, error: 'License expired', expiryDate: expiryDate.toDateString() };
    }
    
    const expectedHash = generateLicenseHash(machineId, expiryDate.toISOString().split('T')[0]);
    // SECURITY: Compare full hash (all 20 chars) instead of just first 8
    if (parts[3] !== expectedHash.substring(0, parts[3].length)) {
      return { valid: false, error: 'Invalid license key (corrupted)' };
    }
    
    return { 
      valid: true, 
      machineId, 
      expiryDate: expiryDate.toDateString(),
      daysRemaining: Math.ceil((expiryDate - currentDate) / (1000 * 60 * 60 * 24))
    };
  } catch (err) {
    console.error('License validation error:', err);
    return { valid: false, error: 'Invalid license format' };
  }
}

function generateTestLicense(days = 30) {
  try {
    const machineId = getMachineId();
    const now = new Date();
    const expiry = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const yy = String(expiry.getFullYear()).slice(-2);
    const mm = String(expiry.getMonth() + 1).padStart(2, '0');
    const dd = String(expiry.getDate()).padStart(2, '0');
    const expiryPart = `${yy}${mm}${dd}`;
    const machinePart = machineId.substring(0, 4);
    const hash = generateLicenseHash(machineId, expiry.toISOString().split('T')[0]).substring(0, 8).toUpperCase();
    const key = `MIG-${machinePart}-${expiryPart}-${hash}`;
    return { key, expiryDate: expiry.toDateString(), machineId };
  } catch (err) {
    return { error: err.message };
  }
}

function getLicenseTier() {
  const key = getSetting('license_key');
  const status = getSetting('license_status');
  
  // Check trial expiry
  const trialExpiry = getSetting('trial_expiry');
  if (!key && trialExpiry) {
    const expiryDate = new Date(trialExpiry);
    if (new Date() > expiryDate) {
      return 'expired';
    }
    return 'trial';
  }
  
  if (!key || status !== 'active') return 'trial';
  
  // For v2 keys (MIG2-), use the stored license_type (set by IPC validators)
  if (key.startsWith('MIG2-')) {
    const storedType = getSetting('license_type');
    if (storedType) {
      const map = { personal: 'starter', starter: 'starter', professional: 'pro', pro: 'pro', enterprise: 'business', business: 'business', standard: 'starter' };
      if (map[storedType]) return map[storedType];
    }
    return 'starter'; // default for any valid v2 key
  }

  // Parse tier from v1 license key format (embedded markers)
  if (key.includes('STR')) return 'starter';
  if (key.includes('PRO')) return 'pro';
  if (key.includes('BIZ')) return 'business';
  
  return 'trial';
}

function getTierLimits(tier) {
  const limits = {
    trial: { clients: 10, loans: 20, collateral: true, reports: ['basic'], exports: ['csv'] },
    starter: { clients: 50, loans: 100, collateral: false, reports: ['basic'], exports: ['csv'] },
    pro: { clients: 200, loans: 1000, collateral: true, reports: ['basic', 'advanced'], exports: ['csv', 'pdf'] },
    business: { clients: Infinity, loans: Infinity, collateral: true, reports: ['basic', 'advanced', 'custom'], exports: ['csv', 'pdf', 'excel'] },
    expired: { clients: 0, loans: 0, collateral: false, reports: [], exports: [] }
  };
  return limits[tier] || limits.trial;
}

function checkTierLimit(entityType) {
  // License limits temporarily disabled — full access mode
  return { allowed: true, tier: 'enterprise', limit: Infinity, current: 0 };
}

function canUseFeature(feature) {
  const tier = getLicenseTier();
  const limits = getTierLimits(tier);
  
  if (feature === 'collateral') return limits.collateral;
  if (feature === 'advanced_reports') return limits.reports.includes('advanced');
  if (feature === 'pdf_export') return limits.exports.includes('pdf');
  
  return false;
}

function getUserByUsername(username) {
  const res = db.exec(`SELECT id, username, passwordHash, salt, secQuestion, secAnswerHash, role, permissions, isActive, lastLogin FROM users WHERE LOWER(username) = LOWER(?)`, [username]);
  if (!res[0]) return null;
  const row = res[0].values[0];
  return {
    id: row[0],
    username: row[1],
    passwordHash: row[2],
    salt: row[3],
    secQuestion: row[4],
    secAnswerHash: row[5],
    role: row[6] || 'user',
    permissions: row[7] || 'read,write',
    isActive: row[8] !== 0,
    lastLogin: row[9]
  };
}

async function registerUser({ username, password, secQuestion, secAnswer, role = 'user', permissions = 'read,write' }) {
  const existing = getUserByUsername(username);
  if (existing) return { success: false, error: 'User already exists' };
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = await hashPasswordBcrypt(password);
  const secAnswerHash = secAnswer ? await hashPasswordBcrypt(secAnswer.trim().toLowerCase()) : null;
  db.run(`INSERT INTO users (username, passwordHash, salt, secQuestion, secAnswerHash, role, permissions, isActive) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [username.trim(), passwordHash, salt, secQuestion || null, secAnswerHash, role, permissions]);
  const res = db.exec(`SELECT last_insert_rowid() as id`);
  const newId = res[0]?.values[0]?.[0] || Date.now();
  logAudit('CREATE', 'user', newId, null, username.trim());
  saveDB();
  return { success: true, user: { id: newId, username: username.trim(), secQuestion } };
}

async function verifyUser(username, password) {
  const user = getUserByUsername(username);
  if (!user) return { success: false, error: 'User not found' };
  if (!user.isActive) return { success: false, error: 'Account is inactive. Contact administrator.' };
  
  let match = false;
  let needsMigration = false;
  
  // Try bcrypt first (hashes starting with $2a$ or $2b$ are bcrypt)
  if (user.passwordHash && user.passwordHash.startsWith('$2')) {
    match = await verifyPassword(password, user.passwordHash);
  } else {
    // Fallback to legacy SHA256
    match = hashPassword(password, user.salt) === user.passwordHash;
    needsMigration = match; // Migrate to bcrypt if successful
  }
  
  if (!match) return { success: false, error: 'Invalid credentials' };
  
  // Migrate to bcrypt on successful legacy login
  if (needsMigration) {
    const newHash = await hashPasswordBcrypt(password);
    db.run(`UPDATE users SET passwordHash = ? WHERE id = ?`, [newHash, user.id]);
    logAudit('UPDATE', 'user', user.id, 'PASSWORD_MIGRATED_TO_BCRYPT', user.username);
    saveDB();
  }
  
  // Update last login
  db.run(`UPDATE users SET lastLogin = datetime('now') WHERE id = ?`, [user.id]);
  saveDB();
  
  return { 
    success: true, 
    user: { 
      id: user.id, 
      username: user.username, 
      secQuestion: user.secQuestion,
      role: user.role,
      permissions: user.permissions
    } 
  };
}

async function recoverUser(username, answer, newPassword) {
  const user = getUserByUsername(username);
  if (!user) return { success: false, error: 'User not found' };
  if (!user.secAnswerHash) return { success: false, error: 'Recovery not set' };
  
  // Verify answer - check both bcrypt and legacy
  let answerMatch = false;
  if (user.secAnswerHash.startsWith('$2')) {
    answerMatch = await verifyPassword((answer || '').trim().toLowerCase(), user.secAnswerHash);
  } else {
    const answerHash = hashPassword((answer || '').trim().toLowerCase(), user.salt);
    answerMatch = answerHash === user.secAnswerHash;
  }
  
  if (!answerMatch) return { success: false, error: 'Incorrect answer' };
  if (!newPassword) return { success: true, needsReset: true, secQuestion: user.secQuestion };
  
  const newHash = await hashPasswordBcrypt(newPassword);
  db.run(`UPDATE users SET passwordHash = ? WHERE id = ?`, [newHash, user.id]);
  logAudit('UPDATE', 'user', user.id, 'PASSWORD_RESET', user.username);
  saveDB();
  return { success: true };
}

async function changePassword(username, currentPassword, newPassword) {
  const user = getUserByUsername(username);
  if (!user) return { success: false, error: 'User not found' };
  
  // Verify current password - support both bcrypt and legacy
  let match = false;
  if (user.passwordHash.startsWith('$2')) {
    match = await verifyPassword(currentPassword, user.passwordHash);
  } else {
    match = hashPassword(currentPassword, user.salt) === user.passwordHash;
  }
  
  if (!match) return { success: false, error: 'Current password incorrect' };
  
  const newHash = await hashPasswordBcrypt(newPassword);
  db.run(`UPDATE users SET passwordHash = ? WHERE id = ?`, [newHash, user.id]);
  logAudit('UPDATE', 'user', user.id, 'PASSWORD_CHANGE', user.username);
  saveDB();
  return { success: true };
}

function getAllUsers() {
  const res = db.exec(`SELECT id, username, role, permissions, isActive, created_at, lastLogin FROM users ORDER BY created_at DESC`);
  if (!res[0]) return [];
  return res[0].values.map(row => ({
    id: row[0],
    username: row[1],
    role: row[2] || 'user',
    permissions: row[3] || 'read,write',
    isActive: row[4] !== 0,
    createdAt: row[5],
    lastLogin: row[6]
  }));
}

function updateUserRole(userId, role, permissions) {
  db.run(`UPDATE users SET role = ?, permissions = ? WHERE id = ?`, [role, permissions, userId]);
  logAudit('UPDATE', 'user', userId, 'ROLE_CHANGE', `${role}:${permissions}`);
  saveDB();
  return { success: true };
}

function toggleUserStatus(userId, isActive) {
  db.run(`UPDATE users SET isActive = ? WHERE id = ?`, [isActive ? 1 : 0, userId]);
  logAudit('UPDATE', 'user', userId, 'STATUS_CHANGE', isActive ? 'ACTIVE' : 'INACTIVE');
  saveDB();
  return { success: true };
}

function deleteUser(userId) {
  db.run(`DELETE FROM users WHERE id = ?`, [userId]);
  logAudit('DELETE', 'user', userId, null, 'USER_DELETED');
  saveDB();
  return { success: true };
}

function resetDatabase() {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  db = new SQL.Database();
  return initDB();
}

// ===== PAYMENTS & FINANCIAL ANALYTICS MODULE (v2.4.0) =====

/**
 * Generate unique receipt number: RCP-YYYYMMDD-XXXXX
 */
function generateReceiptNumber() {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
  const res = db.exec(`SELECT COUNT(*) FROM payments WHERE paymentDate LIKE ?`, [`${today.toISOString().slice(0, 10)}%`]);
  const count = (res[0]?.values[0]?.[0] || 0) + 1;
  return `RCP-${dateStr}-${String(count).padStart(5, '0')}`;
}

/**
 * Get payment statistics for dashboard
 */
function getPaymentStats(period = 'all') {
  try {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    
    // Calculate date ranges
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());
    const weekStr = startOfWeek.toISOString().slice(0, 10);
    
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthStr = startOfMonth.toISOString().slice(0, 10);
    
    const startOfYear = new Date(today.getFullYear(), 0, 1);
    const yearStr = startOfYear.toISOString().slice(0, 10);
    
    // Get collections by period
    const todayRes = db.exec(`
      SELECT COALESCE(SUM(amount), 0), COUNT(*) 
      FROM payments 
      WHERE paymentDate LIKE ? AND (status = 'completed' OR status IS NULL)
    `, [todayStr + '%']);
    
    const weekRes = db.exec(`
      SELECT COALESCE(SUM(amount), 0), COUNT(*) 
      FROM payments 
      WHERE paymentDate >= ? AND (status = 'completed' OR status IS NULL)
    `, [weekStr]);
    
    const monthRes = db.exec(`
      SELECT COALESCE(SUM(amount), 0), COUNT(*) 
      FROM payments 
      WHERE paymentDate >= ? AND (status = 'completed' OR status IS NULL)
    `, [monthStr]);
    
    const yearRes = db.exec(`
      SELECT COALESCE(SUM(amount), 0), COUNT(*) 
      FROM payments 
      WHERE paymentDate >= ? AND (status = 'completed' OR status IS NULL)
    `, [yearStr]);
    
    const allTimeRes = db.exec(`
      SELECT COALESCE(SUM(amount), 0), COUNT(*) 
      FROM payments 
      WHERE status = 'completed' OR status IS NULL
    `);
    
    // Get payment method breakdown
    const methodRes = db.exec(`
      SELECT COALESCE(paymentMethod, 'cash'), SUM(amount), COUNT(*)
      FROM payments 
      WHERE paymentDate >= ? AND (status = 'completed' OR status IS NULL)
      GROUP BY COALESCE(paymentMethod, 'cash')
    `, [monthStr]);
    
    const byMethod = {};
    if (methodRes[0]) {
      for (const row of methodRes[0].values) {
        byMethod[row[0]] = { amount: row[1] || 0, count: row[2] || 0 };
      }
    }
    
    // Get average payment amount
    const avgRes = db.exec(`
      SELECT AVG(amount) FROM payments 
      WHERE paymentDate >= ? AND (status = 'completed' OR status IS NULL)
    `, [monthStr]);
    
    // Get last 7 days trend
    const trendRes = db.exec(`
      SELECT DATE(paymentDate), SUM(amount), COUNT(*)
      FROM payments 
      WHERE paymentDate >= date('now', '-7 days') AND (status = 'completed' OR status IS NULL)
      GROUP BY DATE(paymentDate)
      ORDER BY DATE(paymentDate)
    `);
    
    const dailyTrend = [];
    if (trendRes[0]) {
      for (const row of trendRes[0].values) {
        dailyTrend.push({ date: row[0], amount: row[1] || 0, count: row[2] || 0 });
      }
    }
    
    // Get expected collections (upcoming installments)
    const expectedRes = db.exec(`
      SELECT COALESCE(SUM(amount - paidAmount), 0)
      FROM loan_installments 
      WHERE dueDate BETWEEN ? AND date('now', '+7 days') AND status != 'paid'
    `, [todayStr]);
    
    // Get overdue collections
    const overdueRes = db.exec(`
      SELECT COALESCE(SUM(amount - paidAmount), 0), COUNT(*)
      FROM loan_installments 
      WHERE dueDate < ? AND status != 'paid'
    `, [todayStr]);
    
    return {
      today: { amount: todayRes[0]?.values[0]?.[0] || 0, count: todayRes[0]?.values[0]?.[1] || 0 },
      week: { amount: weekRes[0]?.values[0]?.[0] || 0, count: weekRes[0]?.values[0]?.[1] || 0 },
      month: { amount: monthRes[0]?.values[0]?.[0] || 0, count: monthRes[0]?.values[0]?.[1] || 0 },
      year: { amount: yearRes[0]?.values[0]?.[0] || 0, count: yearRes[0]?.values[0]?.[1] || 0 },
      allTime: { amount: allTimeRes[0]?.values[0]?.[0] || 0, count: allTimeRes[0]?.values[0]?.[1] || 0 },
      byMethod,
      averagePayment: avgRes[0]?.values[0]?.[0] || 0,
      dailyTrend,
      expectedThisWeek: expectedRes[0]?.values[0]?.[0] || 0,
      overdueAmount: overdueRes[0]?.values[0]?.[0] || 0,
      overdueCount: overdueRes[0]?.values[0]?.[1] || 0
    };
  } catch (err) {
    console.error('[PaymentStats] Error:', err);
    return { error: err.message };
  }
}

/**
 * Get profit analysis - tracks income from interest, penalties, fees
 */
function getProfitAnalysis(startDate = null, endDate = null) {
  try {
    const today = new Date();
    const start = startDate || new Date(today.getFullYear(), 0, 1).toISOString().slice(0, 10);
    const end = endDate || today.toISOString().slice(0, 10);
    
    // Interest income from payments
    const interestRes = db.exec(`
      SELECT COALESCE(SUM(interestPortion), 0)
      FROM payments 
      WHERE paymentDate BETWEEN ? AND ? AND (status = 'completed' OR status IS NULL)
    `, [start, end + ' 23:59:59']);
    
    // Penalty income
    const penaltyPaymentRes = db.exec(`
      SELECT COALESCE(SUM(penaltyPortion), 0)
      FROM payments 
      WHERE paymentDate BETWEEN ? AND ? AND (status = 'completed' OR status IS NULL)
    `, [start, end + ' 23:59:59']);
    
    // Total penalties assessed
    const penaltiesAssessedRes = db.exec(`
      SELECT COALESCE(SUM(amount), 0), COUNT(*)
      FROM penalties 
      WHERE createdAt BETWEEN ? AND ?
    `, [start, end + ' 23:59:59']);
    
    // Penalties collected
    const penaltiesCollectedRes = db.exec(`
      SELECT COALESCE(SUM(paidAmount), 0)
      FROM penalties 
      WHERE paidDate BETWEEN ? AND ?
    `, [start, end + ' 23:59:59']);
    
    // Fee income
    const feeRes = db.exec(`
      SELECT COALESCE(SUM(feePortion), 0)
      FROM payments 
      WHERE paymentDate BETWEEN ? AND ? AND (status = 'completed' OR status IS NULL)
    `, [start, end + ' 23:59:59']);
    
    // Early settlement discounts given (lost income)
    const discountRes = db.exec(`
      SELECT earlySettlementHistory FROM loans 
      WHERE earlySettlementHistory IS NOT NULL AND earlySettlementHistory != '[]'
    `);
    
    let discountsGiven = 0;
    if (discountRes[0]) {
      for (const row of discountRes[0].values) {
        try {
          const history = JSON.parse(row[0] || '[]');
          for (const entry of history) {
            if (entry.date >= start && entry.date <= end) {
              discountsGiven += entry.discount || 0;
            }
          }
        } catch (e) {}
      }
    }
    
    // Principal disbursed vs recovered
    const disbursedRes = db.exec(`
      SELECT COALESCE(SUM(amount), 0), COUNT(*)
      FROM loans 
      WHERE loanDate BETWEEN ? AND ?
    `, [start, end + ' 23:59:59']);
    
    const principalRecoveredRes = db.exec(`
      SELECT COALESCE(SUM(principalPortion), 0)
      FROM payments 
      WHERE paymentDate BETWEEN ? AND ? AND (status = 'completed' OR status IS NULL)
    `, [start, end + ' 23:59:59']);
    
    // Monthly breakdown
    const monthlyRes = db.exec(`
      SELECT 
        strftime('%Y-%m', paymentDate) as month,
        SUM(amount) as totalCollected,
        SUM(principalPortion) as principal,
        SUM(interestPortion) as interest,
        SUM(penaltyPortion) as penalties,
        SUM(feePortion) as fees,
        COUNT(*) as transactionCount
      FROM payments 
      WHERE paymentDate BETWEEN ? AND ? AND (status = 'completed' OR status IS NULL)
      GROUP BY strftime('%Y-%m', paymentDate)
      ORDER BY month
    `, [start, end + ' 23:59:59']);
    
    const monthlyBreakdown = [];
    if (monthlyRes[0]) {
      for (const row of monthlyRes[0].values) {
        monthlyBreakdown.push({
          month: row[0],
          totalCollected: row[1] || 0,
          principal: row[2] || 0,
          interest: row[3] || 0,
          penalties: row[4] || 0,
          fees: row[5] || 0,
          transactions: row[6] || 0,
          profit: (row[3] || 0) + (row[4] || 0) + (row[5] || 0) // interest + penalties + fees
        });
      }
    }
    
    const interestIncome = interestRes[0]?.values[0]?.[0] || 0;
    const penaltyIncome = penaltyPaymentRes[0]?.values[0]?.[0] || 0;
    const feeIncome = feeRes[0]?.values[0]?.[0] || 0;
    const totalProfit = interestIncome + penaltyIncome + feeIncome;
    
    return {
      period: { start, end },
      income: {
        interest: interestIncome,
        penalties: penaltyIncome,
        fees: feeIncome,
        total: totalProfit
      },
      penaltiesAssessed: penaltiesAssessedRes[0]?.values[0]?.[0] || 0,
      penaltiesCount: penaltiesAssessedRes[0]?.values[0]?.[1] || 0,
      penaltiesCollected: penaltiesCollectedRes[0]?.values[0]?.[0] || 0,
      discountsGiven,
      principalDisbursed: disbursedRes[0]?.values[0]?.[0] || 0,
      loansIssued: disbursedRes[0]?.values[0]?.[1] || 0,
      principalRecovered: principalRecoveredRes[0]?.values[0]?.[0] || 0,
      netCashFlow: (principalRecoveredRes[0]?.values[0]?.[0] || 0) + totalProfit - (disbursedRes[0]?.values[0]?.[0] || 0),
      monthlyBreakdown,
      profitMargin: totalProfit > 0 ? ((totalProfit / (totalProfit + (principalRecoveredRes[0]?.values[0]?.[0] || 1))) * 100).toFixed(2) : 0
    };
  } catch (err) {
    console.error('[ProfitAnalysis] Error:', err);
    return { error: err.message };
  }
}

/**
 * Get collection trends and performance metrics
 */
function getCollectionTrends() {
  try {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    
    // Collection rate (collected vs expected)
    const expectedRes = db.exec(`
      SELECT COALESCE(SUM(amount), 0)
      FROM loan_installments 
      WHERE dueDate <= ? AND status != 'paid'
    `, [todayStr]);
    
    const collectedRes = db.exec(`
      SELECT COALESCE(SUM(paidAmount), 0)
      FROM loan_installments 
      WHERE dueDate <= ?
    `, [todayStr]);
    
    // Weekly comparison (this week vs last week)
    const thisWeekRes = db.exec(`
      SELECT COALESCE(SUM(amount), 0), COUNT(*)
      FROM payments 
      WHERE paymentDate >= date('now', '-7 days') AND (status = 'completed' OR status IS NULL)
    `);
    
    const lastWeekRes = db.exec(`
      SELECT COALESCE(SUM(amount), 0), COUNT(*)
      FROM payments 
      WHERE paymentDate >= date('now', '-14 days') AND paymentDate < date('now', '-7 days') AND (status = 'completed' OR status IS NULL)
    `);
    
    // Monthly comparison (this month vs last month)
    const thisMonthRes = db.exec(`
      SELECT COALESCE(SUM(amount), 0), COUNT(*)
      FROM payments 
      WHERE strftime('%Y-%m', paymentDate) = strftime('%Y-%m', 'now') AND (status = 'completed' OR status IS NULL)
    `);
    
    const lastMonthRes = db.exec(`
      SELECT COALESCE(SUM(amount), 0), COUNT(*)
      FROM payments 
      WHERE strftime('%Y-%m', paymentDate) = strftime('%Y-%m', 'now', '-1 month') AND (status = 'completed' OR status IS NULL)
    `);
    
    // Year over year comparison
    const thisYearRes = db.exec(`
      SELECT COALESCE(SUM(amount), 0), COUNT(*)
      FROM payments 
      WHERE strftime('%Y', paymentDate) = strftime('%Y', 'now') AND (status = 'completed' OR status IS NULL)
    `);
    
    const lastYearRes = db.exec(`
      SELECT COALESCE(SUM(amount), 0), COUNT(*)
      FROM payments 
      WHERE strftime('%Y', paymentDate) = strftime('%Y', 'now', '-1 year') AND (status = 'completed' OR status IS NULL)
    `);
    
    // Top paying clients this month
    const topClientsRes = db.exec(`
      SELECT c.name, c.id, SUM(p.amount) as totalPaid, COUNT(p.id) as paymentCount
      FROM payments p
      JOIN loans l ON p.loanId = l.id
      JOIN clients c ON l.clientId = c.id
      WHERE strftime('%Y-%m', p.paymentDate) = strftime('%Y-%m', 'now') AND (p.status = 'completed' OR p.status IS NULL)
      GROUP BY c.id
      ORDER BY totalPaid DESC
      LIMIT 10
    `);
    
    const topClients = [];
    if (topClientsRes[0]) {
      for (const row of topClientsRes[0].values) {
        topClients.push({ name: row[0], clientId: row[1], totalPaid: row[2] || 0, paymentCount: row[3] || 0 });
      }
    }
    
    // Payment timing analysis
    const timingRes = db.exec(`
      SELECT 
        CASE 
          WHEN julianday(p.paymentDate) <= julianday(i.dueDate) THEN 'onTime'
          WHEN julianday(p.paymentDate) <= julianday(i.dueDate) + 7 THEN 'late1Week'
          WHEN julianday(p.paymentDate) <= julianday(i.dueDate) + 30 THEN 'late1Month'
          ELSE 'late30Plus'
        END as timing,
        COUNT(*), SUM(p.amount)
      FROM payments p
      LEFT JOIN loan_installments i ON p.installmentId = i.id
      WHERE strftime('%Y-%m', p.paymentDate) = strftime('%Y-%m', 'now') AND (p.status = 'completed' OR p.status IS NULL)
      GROUP BY timing
    `);
    
    const paymentTiming = { onTime: 0, late1Week: 0, late1Month: 0, late30Plus: 0 };
    if (timingRes[0]) {
      for (const row of timingRes[0].values) {
        if (row[0]) paymentTiming[row[0]] = { count: row[1] || 0, amount: row[2] || 0 };
      }
    }
    
    // Calculate growth rates
    const thisWeek = thisWeekRes[0]?.values[0]?.[0] || 0;
    const lastWeek = lastWeekRes[0]?.values[0]?.[0] || 0;
    const thisMonth = thisMonthRes[0]?.values[0]?.[0] || 0;
    const lastMonth = lastMonthRes[0]?.values[0]?.[0] || 0;
    const thisYear = thisYearRes[0]?.values[0]?.[0] || 0;
    const lastYear = lastYearRes[0]?.values[0]?.[0] || 0;
    
    return {
      collectionRate: {
        expected: expectedRes[0]?.values[0]?.[0] || 0,
        collected: collectedRes[0]?.values[0]?.[0] || 0,
        rate: ((collectedRes[0]?.values[0]?.[0] || 0) / (expectedRes[0]?.values[0]?.[0] || 1) * 100).toFixed(1)
      },
      weeklyComparison: {
        thisWeek: { amount: thisWeek, count: thisWeekRes[0]?.values[0]?.[1] || 0 },
        lastWeek: { amount: lastWeek, count: lastWeekRes[0]?.values[0]?.[1] || 0 },
        growthRate: lastWeek > 0 ? (((thisWeek - lastWeek) / lastWeek) * 100).toFixed(1) : 0
      },
      monthlyComparison: {
        thisMonth: { amount: thisMonth, count: thisMonthRes[0]?.values[0]?.[1] || 0 },
        lastMonth: { amount: lastMonth, count: lastMonthRes[0]?.values[0]?.[1] || 0 },
        growthRate: lastMonth > 0 ? (((thisMonth - lastMonth) / lastMonth) * 100).toFixed(1) : 0
      },
      yearlyComparison: {
        thisYear: { amount: thisYear, count: thisYearRes[0]?.values[0]?.[1] || 0 },
        lastYear: { amount: lastYear, count: lastYearRes[0]?.values[0]?.[1] || 0 },
        growthRate: lastYear > 0 ? (((thisYear - lastYear) / lastYear) * 100).toFixed(1) : 0
      },
      topClients,
      paymentTiming
    };
  } catch (err) {
    console.error('[CollectionTrends] Error:', err);
    return { error: err.message };
  }
}

/**
 * Smart financial advisory based on trends and data
 */
function getFinancialAdvisory() {
  try {
    const advisories = [];
    const stats = getPaymentStats();
    const trends = getCollectionTrends();
    const profit = getProfitAnalysis();
    
    // 1. Collection rate advisory
    const collectionRate = parseFloat(trends.collectionRate?.rate || 0);
    if (collectionRate < 70) {
      advisories.push({
        type: 'critical',
        category: 'collections',
        title: 'Critical: Low Collection Rate',
        message: `Collection rate at ${collectionRate}% is critically low. Consider implementing stricter follow-up procedures and offering early settlement incentives.`,
        metric: collectionRate,
        target: 85
      });
    } else if (collectionRate < 85) {
      advisories.push({
        type: 'warning',
        category: 'collections',
        title: 'Collection Rate Below Target',
        message: `Collection rate at ${collectionRate}% is below the 85% target. Focus on overdue accounts and consider reminder automation.`,
        metric: collectionRate,
        target: 85
      });
    } else {
      advisories.push({
        type: 'success',
        category: 'collections',
        title: 'Healthy Collection Rate',
        message: `Excellent! Collection rate at ${collectionRate}% exceeds target. Maintain current collection strategies.`,
        metric: collectionRate,
        target: 85
      });
    }
    
    // 2. Weekly trend advisory
    const weeklyGrowth = parseFloat(trends.weeklyComparison?.growthRate || 0);
    if (weeklyGrowth < -20) {
      advisories.push({
        type: 'critical',
        category: 'trend',
        title: 'Sharp Decline in Collections',
        message: `Collections dropped ${Math.abs(weeklyGrowth)}% compared to last week. Investigate causes and consider proactive client outreach.`,
        metric: weeklyGrowth,
        target: 0
      });
    } else if (weeklyGrowth < -5) {
      advisories.push({
        type: 'warning',
        category: 'trend',
        title: 'Declining Collection Trend',
        message: `Collections down ${Math.abs(weeklyGrowth)}% from last week. Monitor closely and adjust strategies if decline continues.`,
        metric: weeklyGrowth,
        target: 0
      });
    } else if (weeklyGrowth > 10) {
      advisories.push({
        type: 'success',
        category: 'trend',
        title: 'Strong Collection Growth',
        message: `Excellent! Collections up ${weeklyGrowth}% from last week. Current strategies are effective.`,
        metric: weeklyGrowth,
        target: 0
      });
    }
    
    // 3. Overdue accounts advisory
    const overdueAmount = stats.overdueAmount || 0;
    const overdueCount = stats.overdueCount || 0;
    if (overdueCount > 0) {
      advisories.push({
        type: overdueAmount > 100000 ? 'critical' : 'warning',
        category: 'overdue',
        title: `${overdueCount} Overdue Installments`,
        message: `K ${overdueAmount.toLocaleString()} outstanding across ${overdueCount} overdue installments. Prioritize collection efforts on these accounts.`,
        metric: overdueAmount,
        action: 'View overdue accounts'
      });
    }
    
    // 4. Penalty income advisory
    const penaltiesAssessed = profit.penaltiesAssessed || 0;
    const penaltiesCollected = profit.penaltiesCollected || 0;
    const penaltyCollectionRate = penaltiesAssessed > 0 ? (penaltiesCollected / penaltiesAssessed * 100) : 100;
    if (penaltyCollectionRate < 50 && penaltiesAssessed > 0) {
      advisories.push({
        type: 'info',
        category: 'penalties',
        title: 'Low Penalty Collection',
        message: `Only ${penaltyCollectionRate.toFixed(0)}% of assessed penalties have been collected. Consider penalty payment plans for struggling clients.`,
        metric: penaltyCollectionRate,
        target: 80
      });
    }
    
    // 5. Profit margin advisory
    const profitMargin = parseFloat(profit.profitMargin || 0);
    if (profitMargin < 10) {
      advisories.push({
        type: 'warning',
        category: 'profitability',
        title: 'Low Profit Margin',
        message: `Profit margin at ${profitMargin}% is below optimal. Review interest rates and operational costs.`,
        metric: profitMargin,
        target: 15
      });
    } else if (profitMargin > 25) {
      advisories.push({
        type: 'success',
        category: 'profitability',
        title: 'Strong Profitability',
        message: `Profit margin at ${profitMargin}% indicates healthy operations. Consider expanding lending capacity.`,
        metric: profitMargin,
        target: 15
      });
    }
    
    // 6. Cash flow advisory
    const netCashFlow = profit.netCashFlow || 0;
    if (netCashFlow < 0) {
      advisories.push({
        type: 'warning',
        category: 'cashflow',
        title: 'Negative Cash Flow',
        message: `Net cash flow is K ${Math.abs(netCashFlow).toLocaleString()} negative. High disbursements may require additional funding.`,
        metric: netCashFlow
      });
    } else if (netCashFlow > 0) {
      advisories.push({
        type: 'success',
        category: 'cashflow',
        title: 'Positive Cash Flow',
        message: `Net positive cash flow of K ${netCashFlow.toLocaleString()}. Good liquidity position for operations.`,
        metric: netCashFlow
      });
    }
    
    // 7. Expected collections this week
    const expected = stats.expectedThisWeek || 0;
    if (expected > 0) {
      advisories.push({
        type: 'info',
        category: 'forecast',
        title: 'Expected Collections This Week',
        message: `K ${expected.toLocaleString()} expected in collections this week. Ensure sufficient follow-up on due accounts.`,
        metric: expected
      });
    }
    
    // Sort by severity
    const severityOrder = { critical: 0, warning: 1, info: 2, success: 3 };
    advisories.sort((a, b) => severityOrder[a.type] - severityOrder[b.type]);
    
    return {
      advisories,
      summary: {
        critical: advisories.filter(a => a.type === 'critical').length,
        warnings: advisories.filter(a => a.type === 'warning').length,
        info: advisories.filter(a => a.type === 'info').length,
        success: advisories.filter(a => a.type === 'success').length
      },
      overallHealth: collectionRate >= 85 && weeklyGrowth >= 0 ? 'excellent' : 
                     collectionRate >= 70 && weeklyGrowth >= -10 ? 'good' :
                     collectionRate >= 50 ? 'fair' : 'poor'
    };
  } catch (err) {
    console.error('[FinancialAdvisory] Error:', err);
    return { error: err.message, advisories: [] };
  }
}

/**
 * Get payments with enhanced details
 */
function getPaymentsEnhanced(filters = {}) {
  try {
    let query = `
      SELECT p.*, l.loanNumber, l.clientId, c.name as clientName, c.clientNumber
      FROM payments p
      LEFT JOIN loans l ON p.loanId = l.id
      LEFT JOIN clients c ON l.clientId = c.id
      WHERE 1=1
    `;
    const params = [];
    
    if (filters.startDate) {
      query += ` AND p.paymentDate >= ?`;
      params.push(filters.startDate);
    }
    if (filters.endDate) {
      query += ` AND p.paymentDate <= ?`;
      params.push(filters.endDate + ' 23:59:59');
    }
    if (filters.clientId) {
      query += ` AND l.clientId = ?`;
      params.push(filters.clientId);
    }
    if (filters.loanId) {
      query += ` AND p.loanId = ?`;
      params.push(filters.loanId);
    }
    if (filters.status) {
      query += ` AND p.status = ?`;
      params.push(filters.status);
    }
    if (filters.paymentMethod) {
      query += ` AND p.paymentMethod = ?`;
      params.push(filters.paymentMethod);
    }
    if (filters.minAmount) {
      query += ` AND p.amount >= ?`;
      params.push(filters.minAmount);
    }
    if (filters.maxAmount) {
      query += ` AND p.amount <= ?`;
      params.push(filters.maxAmount);
    }
    if (filters.search) {
      query += ` AND (c.name LIKE ? OR l.loanNumber LIKE ? OR p.receiptNumber LIKE ? OR p.referenceNumber LIKE ?)`;
      const searchTerm = `%${filters.search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }
    
    query += ` ORDER BY p.paymentDate DESC, p.id DESC`;
    
    if (filters.limit) {
      query += ` LIMIT ?`;
      params.push(filters.limit);
    }
    
    const res = db.exec(query, params);
    if (!res[0]) return [];
    
    const columns = res[0].columns;
    return res[0].values.map(row => {
      const payment = {};
      columns.forEach((col, i) => payment[col] = row[i]);
      return payment;
    });
  } catch (err) {
    console.error('[GetPaymentsEnhanced] Error:', err);
    return [];
  }
}

/**
 * Add payment with enhanced tracking
 */
function addPaymentEnhanced(paymentData) {
  try {
    const receiptNumber = generateReceiptNumber();
    const now = new Date().toISOString();
    
    // Get client ID from loan for denormalization
    const loanRes = db.exec(`SELECT clientId FROM loans WHERE id = ?`, [paymentData.loanId]);
    const clientId = loanRes[0]?.values[0]?.[0] || null;
    
    db.run(`
      INSERT INTO payments (
        loanId, amount, paymentDate, notes, receiptNumber, paymentMethod, 
        referenceNumber, status, principalPortion, interestPortion, penaltyPortion,
        feePortion, receivedBy, paymentChannel, createdAt, clientId, installmentId
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      paymentData.loanId,
      paymentData.amount,
      paymentData.paymentDate || now.slice(0, 10),
      paymentData.notes || null,
      receiptNumber,
      paymentData.paymentMethod || 'cash',
      paymentData.referenceNumber || null,
      'completed',
      paymentData.principalPortion || 0,
      paymentData.interestPortion || 0,
      paymentData.penaltyPortion || 0,
      paymentData.feePortion || 0,
      paymentData.receivedBy || null,
      paymentData.paymentChannel || 'branch',
      now,
      clientId,
      paymentData.installmentId || null
    ]);
    
    const idRes = db.exec(`SELECT last_insert_rowid() as id`);
    const newId = idRes[0]?.values[0]?.[0];
    
    // Update loan balance
    db.run(`UPDATE loans SET paidAmount = paidAmount + ? WHERE id = ?`, [paymentData.amount, paymentData.loanId]);
    
    // Update installment if linked
    if (paymentData.installmentId) {
      db.run(`
        UPDATE loan_installments 
        SET paidAmount = paidAmount + ?, paidDate = ?, status = CASE WHEN paidAmount + ? >= amount THEN 'paid' ELSE 'partial' END
        WHERE id = ?
      `, [paymentData.amount, paymentData.paymentDate || now.slice(0, 10), paymentData.amount, paymentData.installmentId]);
    }
    
    logAudit('CREATE', 'payment', newId, null, JSON.stringify({ ...paymentData, receiptNumber }));
    saveDB();
    
    return { success: true, id: newId, receiptNumber };
  } catch (err) {
    console.error('[AddPaymentEnhanced] Error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Reverse a payment with audit trail
 */
function reversePayment(paymentId, reason, reversedBy) {
  try {
    const paymentRes = db.exec(`SELECT * FROM payments WHERE id = ?`, [paymentId]);
    if (!paymentRes[0]) return { success: false, error: 'Payment not found' };
    
    const payment = {};
    paymentRes[0].columns.forEach((col, i) => payment[col] = paymentRes[0].values[0][i]);
    
    if (payment.status === 'reversed') {
      return { success: false, error: 'Payment already reversed' };
    }
    
    const now = new Date().toISOString();
    
    // Mark payment as reversed
    db.run(`
      UPDATE payments 
      SET status = 'reversed', reversedAt = ?, reversedBy = ?, reversalReason = ?, updatedAt = ?
      WHERE id = ?
    `, [now, reversedBy, reason, now, paymentId]);
    
    // Reverse loan balance update
    db.run(`UPDATE loans SET paidAmount = paidAmount - ? WHERE id = ?`, [payment.amount, payment.loanId]);
    
    // Reverse installment update if linked
    if (payment.installmentId) {
      db.run(`
        UPDATE loan_installments 
        SET paidAmount = paidAmount - ?, status = CASE WHEN paidAmount - ? <= 0 THEN 'pending' ELSE 'partial' END
        WHERE id = ?
      `, [payment.amount, payment.amount, payment.installmentId]);
    }
    
    logAudit('REVERSE', 'payment', paymentId, JSON.stringify(payment), JSON.stringify({ reason, reversedBy }));
    saveDB();
    
    return { success: true, message: 'Payment reversed successfully' };
  } catch (err) {
    console.error('[ReversePayment] Error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Get daily collection report
 */
function getDailyCollectionReport(date = null) {
  try {
    const reportDate = date || new Date().toISOString().slice(0, 10);
    
    const paymentsRes = db.exec(`
      SELECT p.*, l.loanNumber, c.name as clientName, c.phone as clientPhone
      FROM payments p
      LEFT JOIN loans l ON p.loanId = l.id
      LEFT JOIN clients c ON l.clientId = c.id
      WHERE DATE(p.paymentDate) = ? AND (p.status = 'completed' OR p.status IS NULL)
      ORDER BY p.paymentDate DESC
    `, [reportDate]);
    
    const payments = [];
    if (paymentsRes[0]) {
      const cols = paymentsRes[0].columns;
      for (const row of paymentsRes[0].values) {
        const payment = {};
        cols.forEach((col, i) => payment[col] = row[i]);
        payments.push(payment);
      }
    }
    
    const totals = {
      totalAmount: payments.reduce((sum, p) => sum + (p.amount || 0), 0),
      totalPrincipal: payments.reduce((sum, p) => sum + (p.principalPortion || 0), 0),
      totalInterest: payments.reduce((sum, p) => sum + (p.interestPortion || 0), 0),
      totalPenalties: payments.reduce((sum, p) => sum + (p.penaltyPortion || 0), 0),
      totalFees: payments.reduce((sum, p) => sum + (p.feePortion || 0), 0),
      transactionCount: payments.length
    };
    
    // By payment method
    const byMethod = {};
    for (const p of payments) {
      const method = p.paymentMethod || 'cash';
      if (!byMethod[method]) byMethod[method] = { amount: 0, count: 0 };
      byMethod[method].amount += p.amount || 0;
      byMethod[method].count++;
    }
    
    return {
      date: reportDate,
      payments,
      totals,
      byMethod,
      profit: totals.totalInterest + totals.totalPenalties + totals.totalFees
    };
  } catch (err) {
    console.error('[DailyCollectionReport] Error:', err);
    return { error: err.message };
  }
}

/**
 * Get payment chart data for trend visualization (v2.4.1)
 * Returns daily/weekly/monthly aggregated data for charts
 */
function getPaymentChartData(period = 'month', groupBy = 'day') {
  try {
    let dateFormat, dateRange;
    const today = new Date().toISOString().slice(0, 10);
    
    switch (period) {
      case 'week':
        dateFormat = '%Y-%m-%d';
        dateRange = 7;
        break;
      case 'month':
        dateFormat = '%Y-%m-%d';
        dateRange = 30;
        break;
      case 'quarter':
        dateFormat = groupBy === 'week' ? '%Y-W%W' : '%Y-%m-%d';
        dateRange = 90;
        break;
      case 'year':
        dateFormat = groupBy === 'month' ? '%Y-%m' : '%Y-W%W';
        dateRange = 365;
        break;
      default:
        dateFormat = '%Y-%m-%d';
        dateRange = 30;
    }
    
    const res = db.exec(`
      SELECT 
        strftime('${dateFormat}', paymentDate) as period,
        SUM(amount) as total,
        SUM(principalPortion) as principal,
        SUM(interestPortion) as interest,
        SUM(penaltyPortion) as penalties,
        SUM(feePortion) as fees,
        COUNT(*) as count
      FROM payments
      WHERE paymentDate >= DATE('now', '-${dateRange} days')
        AND (status = 'completed' OR status IS NULL)
      GROUP BY strftime('${dateFormat}', paymentDate)
      ORDER BY period ASC
    `);
    
    const chartData = [];
    if (res[0]) {
      for (const row of res[0].values) {
        chartData.push({
          period: row[0],
          total: row[1] || 0,
          principal: row[2] || 0,
          interest: row[3] || 0,
          penalties: row[4] || 0,
          fees: row[5] || 0,
          count: row[6] || 0
        });
      }
    }
    
    // Calculate moving average (7-day for daily data)
    if (groupBy === 'day' && chartData.length > 7) {
      for (let i = 6; i < chartData.length; i++) {
        const window = chartData.slice(i - 6, i + 1);
        chartData[i].movingAvg = window.reduce((sum, d) => sum + d.total, 0) / 7;
      }
    }
    
    return {
      period,
      groupBy,
      data: chartData,
      summary: {
        totalCollected: chartData.reduce((sum, d) => sum + d.total, 0),
        totalProfit: chartData.reduce((sum, d) => sum + d.interest + d.penalties + d.fees, 0),
        avgDaily: chartData.length ? chartData.reduce((sum, d) => sum + d.total, 0) / chartData.length : 0,
        transactionCount: chartData.reduce((sum, d) => sum + d.count, 0)
      }
    };
  } catch (err) {
    console.error('[PaymentChartData] Error:', err);
    return { error: err.message };
  }
}

/**
 * Add a payment promise (commitment to pay)
 */
function addPaymentPromise(promiseData) {
  try {
    const { loanId, clientId, promiseDate, promiseAmount, promiseNotes } = promiseData;
    
    console.log('[AddPaymentPromise] Input data:', promiseData);
    
    if (!loanId || !promiseDate || !promiseAmount) {
      console.log('[AddPaymentPromise] Validation failed:', { loanId, promiseDate, promiseAmount });
      return { success: false, error: 'Loan ID, promise date, and amount are required' };
    }
    
    const now = new Date().toISOString().slice(0, 10);
    
    // Ensure numeric types
    const parsedLoanId = parseInt(loanId, 10);
    const parsedClientId = clientId != null ? parseInt(clientId, 10) : null;
    const parsedAmount = parseFloat(promiseAmount);
    
    console.log('[AddPaymentPromise] Inserting:', { parsedLoanId, parsedClientId, promiseDate, parsedAmount });
    
    db.run(`
      INSERT INTO payments (loanId, clientId, promiseDate, promiseAmount, promiseNotes, promiseStatus, amount, status, paymentDate, createdAt)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, 'promise', ?, ?)
    `, [parsedLoanId, parsedClientId, promiseDate, parsedAmount, promiseNotes || '', now, now]);
    
    // Get the last inserted ID
    const result = db.exec(`SELECT last_insert_rowid() as id`);
    const id = result[0]?.values[0]?.[0] || Date.now();
    
    console.log('[AddPaymentPromise] Inserted with ID:', id);
    
    saveDB();
    logAudit('ADD_PAYMENT_PROMISE', 'payment', id, null, JSON.stringify({ loanId: parsedLoanId, promiseDate, promiseAmount: parsedAmount }));
    
    return { success: true, id };
  } catch (err) {
    console.error('[AddPaymentPromise] Error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Get payment promises (pending, fulfilled, broken)
 */
function getPaymentPromises(filters = {}) {
  try {
    let query = `
      SELECT p.*, l.loanNumber, c.name as clientName, c.phone as clientPhone
      FROM payments p
      LEFT JOIN loans l ON p.loanId = l.id
      LEFT JOIN clients c ON l.clientId = c.id
      WHERE p.status = 'promise'
    `;
    const params = [];
    
    if (filters.loanId) {
      query += ` AND p.loanId = ?`;
      params.push(filters.loanId);
    }
    if (filters.clientId) {
      query += ` AND (p.clientId = ? OR l.clientId = ?)`;
      params.push(filters.clientId, filters.clientId);
    }
    if (filters.promiseStatus) {
      query += ` AND p.promiseStatus = ?`;
      params.push(filters.promiseStatus);
    }
    if (filters.startDate) {
      query += ` AND p.promiseDate >= ?`;
      params.push(filters.startDate);
    }
    if (filters.endDate) {
      query += ` AND p.promiseDate <= ?`;
      params.push(filters.endDate);
    }
    
    query += ` ORDER BY p.promiseDate ASC`;
    
    const res = db.exec(query, params);
    const promises = [];
    
    if (res[0]) {
      const cols = res[0].columns;
      for (const row of res[0].values) {
        const promise = {};
        cols.forEach((col, i) => promise[col] = row[i]);
        // Mark as overdue if past promise date and still pending
        if (promise.promiseStatus === 'pending' && promise.promiseDate < new Date().toISOString().slice(0, 10)) {
          promise.isOverdue = true;
        }
        promises.push(promise);
      }
    }
    
    return promises;
  } catch (err) {
    console.error('[GetPaymentPromises] Error:', err);
    return [];
  }
}

/**
 * Update payment promise status (fulfilled, broken, cancelled)
 */
function updatePaymentPromiseStatus(promiseId, status, actualPaymentId = null) {
  try {
    if (!['pending', 'fulfilled', 'broken', 'cancelled'].includes(status)) {
      return { success: false, error: 'Invalid status' };
    }
    
    const updates = [`promiseStatus = ?`, `updatedAt = ?`];
    const params = [status, new Date().toISOString()];
    
    if (actualPaymentId && status === 'fulfilled') {
      // Link to actual payment
      updates.push(`notes = COALESCE(notes, '') || ' [Fulfilled by payment #' || ? || ']'`);
      params.push(actualPaymentId);
    }
    
    params.push(promiseId);
    
    db.run(`UPDATE payments SET ${updates.join(', ')} WHERE id = ? AND status = 'promise'`, params);
    saveDB();
    logAudit({ action: 'UPDATE_PAYMENT_PROMISE', details: `Promise ${promiseId} marked as ${status}` });
    
    return { success: true };
  } catch (err) {
    console.error('[UpdatePaymentPromise] Error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Get upcoming payment pipeline (due this week)
 */
function getPaymentPipeline(days = 7) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days);
    const endDate = futureDate.toISOString().slice(0, 10);
    
    // Get installments due in the next N days
    const installmentsRes = db.exec(`
      SELECT i.*, l.loanNumber, l.clientId, c.name as clientName, c.phone as clientPhone,
        l.remainingBalance as loanBalance
      FROM loan_installments i
      JOIN loans l ON i.loanId = l.id
      JOIN clients c ON l.clientId = c.id
      WHERE i.dueDate BETWEEN ? AND ?
        AND (i.status = 'pending' OR i.status = 'partial')
        AND l.status NOT IN ('paid', 'cleared', 'written_off')
      ORDER BY i.dueDate ASC
    `, [today, endDate]);
    
    const pipeline = [];
    if (installmentsRes[0]) {
      const cols = installmentsRes[0].columns;
      for (const row of installmentsRes[0].values) {
        const inst = {};
        cols.forEach((col, i) => inst[col] = row[i]);
        inst.daysUntilDue = Math.ceil((new Date(inst.dueDate) - new Date(today)) / (1000 * 60 * 60 * 24));
        pipeline.push(inst);
      }
    }
    
    // Get payment promises in this period
    const promises = getPaymentPromises({ startDate: today, endDate, promiseStatus: 'pending' });
    
    // Summary stats
    const totalExpected = pipeline.reduce((sum, i) => sum + ((i.totalAmount || 0) - (i.paidAmount || 0)), 0);
    const promisedAmount = promises.reduce((sum, p) => sum + (p.promiseAmount || 0), 0);
    
    return {
      installments: pipeline,
      promises,
      summary: {
        expectedAmount: totalExpected,
        promisedAmount,
        installmentCount: pipeline.length,
        promiseCount: promises.length
      }
    };
  } catch (err) {
    console.error('[PaymentPipeline] Error:', err);
    return { error: err.message };
  }
}

// Module exports - ALL CORE FUNCTIONS
module.exports = {
  init: initDB,
  getDbPath: () => dbPath,
  // Raw exec
  exec: execSQL,
  // Utilities
  withTransaction,
  withTransactionAsync,
  withAuditTransaction,
  verifyDBIntegrity,
  // Licensing
  getMachineId,
  validateLicense,
  generateTestLicense,
  getLicenseTier,
  getTierLimits,
  checkTierLimit,
  canUseFeature,
  // Auth
  registerUser: (payload) => registerUser(payload),
  loginUser: (username, password) => verifyUser(username, password),
  recoverUser: (username, answer, newPassword) => recoverUser(username, answer, newPassword),
  changePassword: (username, currentPassword, newPassword) => changePassword(username, currentPassword, newPassword),
  getAllUsers: () => getAllUsers(),
  updateUserRole: (userId, role, permissions) => updateUserRole(userId, role, permissions),
  toggleUserStatus: (userId, isActive) => toggleUserStatus(userId, isActive),
  deleteUser: (userId) => deleteUser(userId),
  resetDatabase: () => resetDatabase(),
  getUser: () => {
    const res = db.exec(`SELECT username, secQuestion FROM users LIMIT 1`);
    if (!res[0]) return null;
    const row = res[0].values[0];
    return { username: row[0], secQuestion: row[1] };
  },
  // Settings
  getSetting: (key) => getSetting(key),
  getSettingByKey: (key) => getSetting(key),
  getAllSettings: () => {
    const res = db.exec(`SELECT key, value FROM settings`);
    if (!res[0]) return {};
    return Object.fromEntries(res[0].values.map(row => [row[0], row[1]]));
  },
  setSetting: (key, value) => {
    const old = getSetting(key);
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value]);
    saveDB();
    logAudit('SETTINGS_CHANGE', 'settings', null, JSON.stringify({ key, old }), JSON.stringify({ key, value }));
    return { success: true };
  },
  // Audit
  logAudit: (action, entityType, entityId, oldVal, newVal) => logAudit(action, entityType, entityId, oldVal, newVal),
  getAuditLog: (limit = 100) => { const res = db.exec(`SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?`, [limit]); if (!res[0]) return []; return res[0].values.map(row => ({ id: row[0], action: row[1], entityType: row[2], entityId: row[3], oldValue: row[4], newValue: row[5], timestamp: row[6] })); },
  clearAuditLog: () => { db.run(`DELETE FROM audit_log`); saveDB(); return { success: true }; },
  deleteAuditEntry: (id) => { db.run(`DELETE FROM audit_log WHERE id = ?`, [id]); saveDB(); return { success: true }; },
  // Clients
  addClient: (client) => { 
    const limitCheck = checkTierLimit('clients');
    if (!limitCheck.allowed) {
      return { success: false, error: limitCheck.message };
    }
    const clientNumber = generateClientNumber(); 
    const now = new Date().toISOString();
    db.run(`INSERT INTO clients (
      clientNumber, name, phone, nrc, email, notes, 
      gender, dateOfBirth, phone2, address, occupation, employer, monthlyIncome, employmentStatus, 
      nokName, nokRelation, nokPhone,
      nationality, city, country, incomeSource, businessName,
      creditScore, riskLevel, clientStatus, blacklisted, lastActivity,
      kycStatus, kycVerifiedDate, kycNotes, profileImage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      clientNumber, 
      client.name, 
      client.phone, 
      client.nrc, 
      client.email, 
      client.notes,
      client.gender || null,
      client.dateOfBirth || null,
      client.phone2 || null,
      client.address || null,
      client.occupation || null,
      client.employer || null,
      client.monthlyIncome || null,
      client.employmentStatus || null,
      client.nokName || null,
      client.nokRelation || null,
      client.nokPhone || null,
      client.nationality || null,
      client.city || null,
      client.country || 'Zambia',
      client.incomeSource || null,
      client.businessName || null,
      client.creditScore || 50,
      client.riskLevel || 'medium',
      client.clientStatus || 'active',
      client.blacklisted || 0,
      now,
      client.kycStatus || 'pending',
      client.kycVerifiedDate || null,
      client.kycNotes || null,
      client.profileImage || null
    ]); 
    const res = db.exec(`SELECT last_insert_rowid() as id`); 
    const newId = res[0]?.values[0]?.[0] || Date.now(); 
    logAudit('CREATE', 'client', newId, null, JSON.stringify(client)); 
    saveDB(); 
    return { id: newId, clientNumber }; 
  },
  getClients: () => { 
    const res = db.exec(`
      SELECT id, clientNumber, name, phone, nrc, email, notes, created_at, 
             gender, dateOfBirth, phone2, address, occupation, employer, monthlyIncome, employmentStatus, 
             nokName, nokRelation, nokPhone,
             nationality, city, country, incomeSource, businessName,
             creditScore, riskLevel, clientStatus, blacklisted, lastActivity,
             kycStatus, kycVerifiedDate, kycNotes, profileImage
      FROM clients ORDER BY created_at DESC
    `); 
    if (!res[0]) return []; 
    return res[0].values.map(row => ({ 
      id: row[0], 
      clientNumber: row[1], 
      name: row[2], 
      phone: row[3], 
      nrc: row[4], 
      email: row[5], 
      notes: row[6], 
      created_at: row[7],
      gender: row[8],
      dateOfBirth: row[9],
      phone2: row[10],
      address: row[11],
      occupation: row[12],
      employer: row[13],
      monthlyIncome: row[14],
      employmentStatus: row[15],
      nokName: row[16],
      nokRelation: row[17],
      nokPhone: row[18],
      nationality: row[19],
      city: row[20],
      country: row[21],
      incomeSource: row[22],
      businessName: row[23],
      creditScore: row[24],
      riskLevel: row[25],
      clientStatus: row[26],
      blacklisted: row[27],
      lastActivity: row[28],
      kycStatus: row[29],
      kycVerifiedDate: row[30],
      kycNotes: row[31],
      profileImage: row[32]
    })); 
  },
  getClientById: (id) => { 
    const res = db.exec(`
      SELECT id, clientNumber, name, phone, nrc, email, notes, created_at, 
             gender, dateOfBirth, phone2, address, occupation, employer, monthlyIncome, employmentStatus, 
             nokName, nokRelation, nokPhone,
             nationality, city, country, incomeSource, businessName,
             creditScore, riskLevel, clientStatus, blacklisted, lastActivity,
             kycStatus, kycVerifiedDate, kycNotes, profileImage
      FROM clients WHERE id = ?
    `, [id]); 
    if (!res[0]) return null; 
    const row = res[0].values[0]; 
    return { 
      id: row[0], 
      clientNumber: row[1], 
      name: row[2], 
      phone: row[3], 
      nrc: row[4], 
      email: row[5], 
      notes: row[6], 
      created_at: row[7],
      gender: row[8],
      dateOfBirth: row[9],
      phone2: row[10],
      address: row[11],
      occupation: row[12],
      employer: row[13],
      monthlyIncome: row[14],
      employmentStatus: row[15],
      nokName: row[16],
      nokRelation: row[17],
      nokPhone: row[18],
      nationality: row[19],
      city: row[20],
      country: row[21],
      incomeSource: row[22],
      businessName: row[23],
      creditScore: row[24],
      riskLevel: row[25],
      clientStatus: row[26],
      blacklisted: row[27],
      lastActivity: row[28],
      kycStatus: row[29],
      kycVerifiedDate: row[30],
      kycNotes: row[31],
      profileImage: row[32]
    }; 
  },
  updateClient: (id, client) => { 
    const oldRes = db.exec(`SELECT * FROM clients WHERE id = ?`, [id]); 
    const oldData = oldRes[0]?.values[0] ? JSON.stringify({ id: oldRes[0].values[0][0], clientNumber: oldRes[0].values[0][1], name: oldRes[0].values[0][2], phone: oldRes[0].values[0][3] }) : null; 
    const now = new Date().toISOString();
    db.run(`UPDATE clients SET 
      name = ?, phone = ?, nrc = ?, email = ?, notes = ?, 
      gender = ?, dateOfBirth = ?, phone2 = ?, address = ?, occupation = ?, employer = ?, monthlyIncome = ?, employmentStatus = ?, 
      nokName = ?, nokRelation = ?, nokPhone = ?,
      nationality = ?, city = ?, country = ?, incomeSource = ?, businessName = ?,
      creditScore = ?, riskLevel = ?, clientStatus = ?, blacklisted = ?, lastActivity = ?,
      kycStatus = ?, kycVerifiedDate = ?, kycNotes = ?, profileImage = ?
      WHERE id = ?`, [
      client.name, 
      client.phone, 
      client.nrc, 
      client.email, 
      client.notes,
      client.gender || null,
      client.dateOfBirth || null,
      client.phone2 || null,
      client.address || null,
      client.occupation || null,
      client.employer || null,
      client.monthlyIncome || null,
      client.employmentStatus || null,
      client.nokName || null,
      client.nokRelation || null,
      client.nokPhone || null,
      client.nationality || null,
      client.city || null,
      client.country || null,
      client.incomeSource || null,
      client.businessName || null,
      client.creditScore !== undefined ? client.creditScore : null,
      client.riskLevel || null,
      client.clientStatus || null,
      client.blacklisted !== undefined ? client.blacklisted : null,
      now,
      client.kycStatus || null,
      client.kycVerifiedDate || null,
      client.kycNotes || null,
      client.profileImage || null,
      id
    ]);
    logAudit('UPDATE', 'client', id, oldData, JSON.stringify(client)); 
    saveDB(); 
    return { changes: 1 }; 
  },
  deleteClient: (id) => { const oldRes = db.exec(`SELECT * FROM clients WHERE id = ?`, [id]); const oldData = oldRes[0]?.values[0] ? JSON.stringify({ id: oldRes[0].values[0][0], clientNumber: oldRes[0].values[0][1], name: oldRes[0].values[0][2] }) : null; db.run(`DELETE FROM clients WHERE id = ?`, [id]); logAudit('DELETE', 'client', id, oldData, null); saveDB(); return { changes: 1 }; },
  
  // ===== ENTERPRISE CLIENT FUNCTIONS (v2.2.0) =====
  
  // Calculate client risk score based on loan performance
  calculateClientRisk: (clientId) => {
    try {
      // Get all loans for client
      const loansRes = db.exec(`
        SELECT l.id, l.amount, l.interest, l.dueDate, l.status,
               COALESCE((SELECT SUM(amount) FROM payments WHERE loanId = l.id), 0) as paidAmount,
               COALESCE((SELECT SUM(amount) FROM penalties WHERE loanId = l.id), 0) as penalties
        FROM loans l WHERE l.clientId = ?
      `, [clientId]);
      
      if (!loansRes[0] || loansRes[0].values.length === 0) {
        // New client with no loans
        return { creditScore: 50, riskLevel: 'medium', totalBorrowed: 0, totalRepaid: 0, activeLoans: 0 };
      }
      
      const loans = loansRes[0].values;
      const today = new Date();
      let totalBorrowed = 0;
      let totalRepaid = 0;
      let activeLoans = 0;
      let overdueLoans = 0;
      let defaultedLoans = 0;
      let clearedLoans = 0;
      
      for (const loan of loans) {
        const amount = Number(loan[1]) || 0;
        const interest = Number(loan[2]) || 0;
        const dueDate = loan[3] ? new Date(loan[3]) : null;
        const status = loan[4];
        const paidAmount = Number(loan[5]) || 0;
        const penalties = Number(loan[6]) || 0;
        
        const totalDue = amount + (amount * interest / 100) + penalties;
        const balance = Math.max(0, totalDue - paidAmount);
        
        totalBorrowed += amount;
        totalRepaid += paidAmount;
        
        if (balance > 0) {
          activeLoans++;
          if (dueDate && today > dueDate) {
            const daysOverdue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
            if (daysOverdue > 90) {
              defaultedLoans++;
            } else {
              overdueLoans++;
            }
          }
        } else {
          clearedLoans++;
        }
      }
      
      // Calculate repayment rate
      const repaymentRate = totalBorrowed > 0 ? (totalRepaid / totalBorrowed) * 100 : 100;
      
      // Get collateral coverage
      const collRes = db.exec(`SELECT SUM(acceptedValue) as totalCollateral FROM collateral WHERE clientId = ? AND status = 'active'`, [clientId]);
      const totalCollateral = collRes[0]?.values[0]?.[0] || 0;
      const collateralCoverage = totalBorrowed > 0 ? (totalCollateral / totalBorrowed) * 100 : 0;
      
      // Calculate risk score: lower is better (0-100)
      // Formula: base 50 + (overdue * 15) + (defaulted * 25) - (repaymentRate * 0.3) - (collateralCoverage * 0.1)
      let riskScore = 50;
      riskScore += overdueLoans * 15;
      riskScore += defaultedLoans * 25;
      riskScore -= repaymentRate * 0.3;
      riskScore -= Math.min(collateralCoverage, 100) * 0.1;
      riskScore = Math.max(0, Math.min(100, riskScore));
      
      // Credit score is inverse of risk (0-100, higher is better)
      const creditScore = Math.round(100 - riskScore);
      
      // Determine risk level
      let riskLevel = 'medium';
      if (riskScore <= 20) riskLevel = 'low';
      else if (riskScore <= 50) riskLevel = 'medium';
      else riskLevel = 'high';
      
      // Determine client status
      let clientStatus = 'active';
      if (defaultedLoans > 0) clientStatus = 'defaulted';
      else if (overdueLoans > 0) clientStatus = 'at_risk';
      
      // Update client record
      db.run(`UPDATE clients SET creditScore = ?, riskLevel = ?, clientStatus = ?, lastActivity = ? WHERE id = ?`, 
        [creditScore, riskLevel, clientStatus, new Date().toISOString(), clientId]);
      saveDB();
      
      return { creditScore, riskLevel, clientStatus, totalBorrowed, totalRepaid, activeLoans, overdueLoans, defaultedLoans, clearedLoans, repaymentRate: Math.round(repaymentRate), collateralCoverage: Math.round(collateralCoverage) };
    } catch (e) {
      console.error('calculateClientRisk error:', e);
      return { creditScore: 50, riskLevel: 'medium', error: e.message };
    }
  },
  
  // Get client statistics (computed fields)
  getClientStats: (clientId) => {
    try {
      const loansRes = db.exec(`
        SELECT 
          COUNT(*) as totalLoans,
          SUM(amount) as totalBorrowed,
          SUM(CASE WHEN status = 'cleared' THEN 1 ELSE 0 END) as clearedLoans
        FROM loans WHERE clientId = ?
      `, [clientId]);
      
      const paymentsRes = db.exec(`
        SELECT SUM(p.amount) as totalPaid 
        FROM payments p 
        JOIN loans l ON p.loanId = l.id 
        WHERE l.clientId = ?
      `, [clientId]);
      
      const collateralRes = db.exec(`
        SELECT SUM(acceptedValue) as totalCollateral, COUNT(*) as collateralCount
        FROM collateral WHERE clientId = ? AND status = 'active'
      `, [clientId]);
      
      const loan = loansRes[0]?.values[0] || [0, 0, 0];
      const paid = paymentsRes[0]?.values[0]?.[0] || 0;
      const coll = collateralRes[0]?.values[0] || [0, 0];
      
      return {
        totalLoans: loan[0] || 0,
        totalBorrowed: loan[1] || 0,
        clearedLoans: loan[2] || 0,
        activeLoans: (loan[0] || 0) - (loan[2] || 0),
        totalRepaid: paid,
        totalCollateral: coll[0] || 0,
        collateralCount: coll[1] || 0
      };
    } catch (e) {
      console.error('getClientStats error:', e);
      return { totalLoans: 0, totalBorrowed: 0, totalRepaid: 0, activeLoans: 0, clearedLoans: 0, totalCollateral: 0, collateralCount: 0 };
    }
  },
  
  // Get client activity from audit log
  getClientActivity: (clientId, limit = 50) => {
    try {
      const res = db.exec(`
        SELECT * FROM audit_log 
        WHERE (entityType = 'client' AND entityId = ?)
           OR (entityType = 'loan' AND entityId IN (SELECT id FROM loans WHERE clientId = ?))
           OR (entityType = 'payment' AND entityId IN (SELECT p.id FROM payments p JOIN loans l ON p.loanId = l.id WHERE l.clientId = ?))
        ORDER BY timestamp DESC LIMIT ?
      `, [clientId, clientId, clientId, limit]);
      if (!res[0]) return [];
      return res[0].values.map(row => ({
        id: row[0],
        action: row[1],
        entityType: row[2],
        entityId: row[3],
        oldValue: row[4],
        newValue: row[5],
        timestamp: row[6]
      }));
    } catch (e) {
      console.error('getClientActivity error:', e);
      return [];
    }
  },
  
  // Blacklist/unblacklist a client
  setClientBlacklist: (clientId, blacklisted, reason = '') => {
    try {
      const status = blacklisted ? 'blacklisted' : 'active';
      db.run(`UPDATE clients SET blacklisted = ?, clientStatus = ?, kycNotes = COALESCE(kycNotes, '') || ? WHERE id = ?`, 
        [blacklisted ? 1 : 0, status, reason ? `\n[BLACKLIST ${blacklisted ? 'ON' : 'OFF'}]: ${reason}` : '', clientId]);
      logAudit(blacklisted ? 'BLACKLIST' : 'UNBLACKLIST', 'client', clientId, null, reason);
      saveDB();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  
  // Update KYC status
  updateKycStatus: (clientId, status, notes = '') => {
    try {
      const verifiedDate = status === 'verified' ? new Date().toISOString() : null;
      db.run(`UPDATE clients SET kycStatus = ?, kycVerifiedDate = ?, kycNotes = COALESCE(kycNotes, '') || ? WHERE id = ?`,
        [status, verifiedDate, notes ? `\n[KYC ${status.toUpperCase()}]: ${notes}` : '', clientId]);
      logAudit('KYC_UPDATE', 'client', clientId, null, JSON.stringify({ status, notes }));
      saveDB();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  
  // Update client profile image
  setClientProfileImage: (clientId, imagePath) => {
    try {
      db.run(`UPDATE clients SET profileImage = ?, lastActivity = ? WHERE id = ?`, [imagePath, new Date().toISOString(), clientId]);
      saveDB();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  
  // Loans
  addLoan: (loan) => { 
    const limitCheck = checkTierLimit('loans');
    if (!limitCheck.allowed) {
      return { success: false, error: limitCheck.message };
    }
    const loanNumber = generateLoanNumber(); 
    db.run(`INSERT INTO loans (loanNumber, clientId, amount, interest, paidAmount, loanDate, dueDate, status, notes, collateral, collateralValue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [loanNumber, loan.clientId, loan.amount, loan.interest, loan.paidAmount || 0, loan.loanDate || today(), loan.dueDate || today(), loan.status || 'pending', loan.notes || null, loan.collateral || null, loan.collateralValue || 0]); 
    const res = db.exec(`SELECT last_insert_rowid() as id`); 
    const newId = res[0]?.values[0]?.[0] || Date.now(); 
    logAudit('CREATE', 'loan', newId, null, JSON.stringify(loan)); 
    saveDB(); 
    return { id: newId, loanNumber }; 
  },
  getLoans: () => { const res = db.exec(`SELECT loans.id, loans.loanNumber, loans.clientId, loans.amount, loans.interest, loans.loanDate, loans.dueDate, loans.status, loans.notes, loans.created_at, clients.name, clients.clientNumber, COALESCE((SELECT SUM(amount) FROM payments WHERE loanId = loans.id), 0) AS paidAmount, COALESCE((SELECT SUM(amount) FROM penalties WHERE loanId = loans.id), 0) AS penaltiesTotal FROM loans LEFT JOIN clients ON loans.clientId = clients.id ORDER BY loans.created_at DESC`); if (!res[0]) return []; const todayDate = new Date(); return res[0].values.map(row => { const totalAmount = row[3] + (row[3] * row[4] / 100) + Number(row[13]); const balance = Math.max(0, totalAmount - Number(row[12])); let daysRemaining = null; if (row[6]) { const due = new Date(row[6]); daysRemaining = Math.ceil((due - todayDate) / (1000 * 60 * 60 * 24)); } return { id: row[0], loanNumber: row[1], clientId: row[2], amount: row[3], interest: row[4], paidAmount: row[12], loanDate: row[5], dueDate: row[6], status: row[7], notes: row[8], created_at: row[9], clientName: row[10], clientNumber: row[11], totalAmount, balance, daysRemaining, penaltiesTotal: row[13] }; }); },
  getLoansByClient: (clientId) => { const res = db.exec(`SELECT * FROM loans WHERE clientId = ? ORDER BY created_at DESC`, [clientId]); if (!res[0]) return []; return res[0].values.map(row => ({ id: row[0], loanNumber: row[1], clientId: row[2], amount: row[3], interest: row[4], loanDate: row[6], dueDate: row[7], status: row[8], notes: row[9], collateral: row[10], collateralValue: row[11], signatureData: row[12], signingDate: row[13], created_at: row[14] })); },
  updateLoan: (id, loan) => { db.run(`UPDATE loans SET amount = ?, interest = ?, loanDate = ?, dueDate = ?, status = ?, notes = ? WHERE id = ?`, [loan.amount, loan.interest, loan.loanDate, loan.dueDate, loan.status, loan.notes, id]); saveDB(); return { changes: 1 }; },
  deleteLoan: (id) => { db.run(`DELETE FROM loans WHERE id = ?`, [id]); logAudit('DELETE', 'loan', id, null, null); saveDB(); return { changes: 1 }; },
    getLoanDetails: (loanId) => {
      const res = db.exec(`
        SELECT loans.*, clients.name, clients.clientNumber
        FROM loans
        LEFT JOIN clients ON loans.clientId = clients.id
        WHERE loans.id = ?
      `, [loanId]);
      if (!res[0] || !res[0].values[0]) return null;

      const row = res[0].values[0];
      const paidAmount = db.exec(`SELECT COALESCE(SUM(amount), 0) FROM payments WHERE loanId = ?`, [loanId])[0]?.values?.[0]?.[0] || 0;
      const penaltiesTotal = db.exec(`SELECT COALESCE(SUM(amount), 0) FROM penalties WHERE loanId = ?`, [loanId])[0]?.values?.[0]?.[0] || 0;
      const totalAmount = Number(row[3] || 0) + (Number(row[3] || 0) * Number(row[4] || 0) / 100) + Number(penaltiesTotal);

      return {
        id: row[0],
        loanNumber: row[1],
        clientId: row[2],
        amount: row[3],
        interest: row[4],
        paidAmount,
        loanDate: row[6],
        dueDate: row[7],
        status: row[8],
        notes: row[9],
        collateral: row[10],
        collateralValue: row[11],
        signatureData: row[12],
        signingDate: row[13],
        created_at: row[14],
        clientName: row[15],
        clientNumber: row[16],
        penaltiesTotal,
        totalAmount,
        balance: Math.max(0, totalAmount - Number(paidAmount))
      };
    },
    saveLoanSignature: (loanId, signatureData) => {
      const oldData = db.exec(`SELECT signatureData, signingDate FROM loans WHERE id = ?`, [loanId]);
      if (!oldData[0] || !oldData[0].values[0]) {
        return { success: false, error: 'Loan not found' };
      }

      const signingDate = today();
      db.run(`UPDATE loans SET signatureData = ?, signingDate = ? WHERE id = ?`, [signatureData, signingDate, loanId]);
      logAudit(
        'UPDATE',
        'loan',
        loanId,
        JSON.stringify({ signatureData: oldData[0].values[0][0], signingDate: oldData[0].values[0][1] }),
        JSON.stringify({ signatureData, signingDate })
      );
      saveDB();
      return { success: true, signingDate };
    },
    getLoanPaymentHistory: (loanId) => {
      const res = db.exec(`SELECT id, loanId, amount, paymentDate, notes FROM payments WHERE loanId = ? ORDER BY paymentDate DESC, id DESC`, [loanId]);
      if (!res[0]) return [];
      return res[0].values.map(row => ({
        id: row[0],
        loanId: row[1],
        amount: row[2],
        paymentDate: row[3],
        notes: row[4]
      }));
    },
    updateCollateralValue: (loanId, collateralValue) => {
      const oldData = db.exec(`SELECT collateralValue FROM loans WHERE id = ?`, [loanId]);
      if (!oldData[0] || !oldData[0].values[0]) {
        return { success: false, error: 'Loan not found' };
      }

      db.run(`UPDATE loans SET collateralValue = ? WHERE id = ?`, [collateralValue, loanId]);
      logAudit('UPDATE', 'loan', loanId, JSON.stringify({ collateralValue: oldData[0].values[0][0] }), JSON.stringify({ collateralValue }));
      saveDB();
      return { success: true, collateralValue };
    },
  // Payments - Enhanced (v2.4.0)
  addPayment: (payment) => { db.run(`INSERT INTO payments (loanId, amount, paymentDate, notes) VALUES (?, ?, ?, ?)`, [payment.loanId, payment.amount, payment.paymentDate || today(), payment.notes]); saveDB(); logAudit('CREATE', 'payment', null, null, JSON.stringify(payment)); return { success: true }; },
  addPaymentEnhanced: (payment) => addPaymentEnhanced(payment),
  getPaymentsByLoan: (loanId) => { const res = db.exec(`SELECT * FROM payments WHERE loanId = ? ORDER BY paymentDate DESC`, [loanId]); if (!res[0]) return []; return res[0].values.map(row => ({ id: row[0], loanId: row[1], amount: row[2], paymentDate: row[3], notes: row[4] })); },
  getAllPayments: () => { const res = db.exec(`SELECT * FROM payments ORDER BY paymentDate DESC`); if (!res[0]) return []; return res[0].values.map(row => ({ id: row[0], loanId: row[1], amount: row[2], paymentDate: row[3], notes: row[4] })); },
  getPaymentsEnhanced: (filters) => getPaymentsEnhanced(filters),
  updatePayment: (id, payment) => { db.run(`UPDATE payments SET amount = ?, paymentDate = ?, notes = ? WHERE id = ?`, [payment.amount, payment.paymentDate, payment.notes, id]); saveDB(); return { success: true }; },
  deletePayment: (id) => { db.run(`DELETE FROM payments WHERE id = ?`, [id]); saveDB(); return { success: true }; },
  reversePayment: (paymentId, reason, reversedBy) => reversePayment(paymentId, reason, reversedBy),
  getPaymentById: (id) => { const res = db.exec(`SELECT * FROM payments WHERE id = ?`, [id]); if (!res[0] || !res[0].values[0]) return null; const row = res[0].values[0]; return { id: row[0], loanId: row[1], amount: row[2], paymentDate: row[3], notes: row[4] }; },
  generateReceiptNumber: () => generateReceiptNumber(),
  // Payment Analytics & Reporting
  getPaymentStats: (period) => getPaymentStats(period),
  getProfitAnalysis: (startDate, endDate) => getProfitAnalysis(startDate, endDate),
  getCollectionTrends: () => getCollectionTrends(),
  getFinancialAdvisory: () => getFinancialAdvisory(),
  getDailyCollectionReport: (date) => getDailyCollectionReport(date),
  getPaymentChartData: (period, groupBy) => getPaymentChartData(period, groupBy),
  addPaymentPromise: (data) => addPaymentPromise(data),
  getPaymentPromises: (filters) => getPaymentPromises(filters),
  updatePaymentPromiseStatus: (id, status, paymentId) => updatePaymentPromiseStatus(id, status, paymentId),
  getPaymentPipeline: (days) => getPaymentPipeline(days),
  // Penalties
  addPenalty: (penalty) => { db.run(`INSERT INTO penalties (loanId, amount, reason) VALUES (?, ?, ?)`, [penalty.loanId, penalty.amount, penalty.reason]); logAudit('CREATE', 'penalty', null, null, JSON.stringify(penalty)); saveDB(); return { success: true }; },
  getPenaltiesByLoan: (loanId) => { const res = db.exec(`SELECT * FROM penalties WHERE loanId = ? ORDER BY createdAt DESC`, [loanId]); if (!res[0]) return []; return res[0].values.map(row => ({ id: row[0], loanId: row[1], amount: row[2], reason: row[3], createdAt: row[4], status: row[5] || 'pending', penaltyType: row[10] || 'late_payment' })); },
  getAllPenalties: () => { const res = db.exec(`SELECT p.id, p.loanId, p.amount, p.reason, p.createdAt, p.status, p.paidDate, p.waivedAt, p.waivedBy, p.paidAmount, p.penaltyType, l.loanNumber, l.clientId, c.name as clientName FROM penalties p LEFT JOIN loans l ON l.id = p.loanId LEFT JOIN clients c ON c.id = l.clientId ORDER BY p.createdAt DESC`); if (!res[0]) return []; return res[0].values.map(row => ({ id: row[0], loanId: row[1], amount: row[2], reason: row[3], createdAt: row[4], status: row[5] || 'pending', paidDate: row[6], waivedAt: row[7], waivedBy: row[8], paidAmount: row[9] || 0, penaltyType: row[10] || 'late_payment', loanNumber: row[11] || ('#' + row[1]), clientId: row[12], clientName: row[13] || '—' })); },
  updatePenaltyStatus: (id, status) => { const now = new Date().toISOString(); if (status === 'paid') { db.run(`UPDATE penalties SET status = 'paid', paidDate = ? WHERE id = ?`, [now, id]); } else if (status === 'waived') { db.run(`UPDATE penalties SET status = 'waived', waivedAt = ? WHERE id = ?`, [now, id]); } else { db.run(`UPDATE penalties SET status = ? WHERE id = ?`, [status, id]); } saveDB(); logAudit('UPDATE', 'penalty', id, null, `Status changed to ${status}`); return { success: true }; },
  deletePenalty: (id) => { db.run(`DELETE FROM penalties WHERE id = ?`, [id]); saveDB(); logAudit('DELETE', 'penalty', id, null, 'Penalty deleted'); return { success: true }; },
  applyAutoPenalties: () => { const todayDate = new Date(); const gracePeriodDays = parseInt(getSetting('grace_period_days') || '0'); const gracePeriodMs = gracePeriodDays * 24 * 60 * 60 * 1000; const loansRes = db.exec(`SELECT id, dueDate FROM loans WHERE status != 'paid' AND dueDate IS NOT NULL`); if (!loansRes[0]) return { applied: 0 }; let penaltiesApplied = 0; loansRes[0].values.forEach(row => { const loanId = row[0]; const dueDate = new Date(row[1]); const graceDeadline = new Date(dueDate.getTime() + gracePeriodMs); if (todayDate > graceDeadline) { const penaltyCheckRes = db.exec(`SELECT COUNT(*) FROM penalties WHERE loanId = ? AND createdAt LIKE ?`, [loanId, todayDate.toISOString().split('T')[0] + '%']); const alreadyAppliedToday = penaltyCheckRes[0]?.values[0]?.[0] || 0; if (!alreadyAppliedToday) { const penaltyRate = parseFloat(getSetting('daily_penalty_rate') || '5'); const loanDetailRes = db.exec(`SELECT amount FROM loans WHERE id = ?`, [loanId]); const loanAmount = loanDetailRes[0]?.values[0]?.[0] || 0; const penaltyAmount = (loanAmount * penaltyRate) / 100; db.run(`INSERT INTO penalties (loanId, amount, reason) VALUES (?, ?, ?)`, [loanId, penaltyAmount, `Auto-penalty (${penaltyRate}% daily) - Overdue since ${dueDate.toDateString()}`]); penaltiesApplied++; } } }); saveDB(); logAudit('AUTO_PENALTY', 'system', null, null, `Applied ${penaltiesApplied} penalties`); return { applied: penaltiesApplied }; },
  // Collateral - full implementation
  addCollateral: (data) => { 
    if (!canUseFeature('collateral')) {
      return { success: false, error: 'Collateral management requires Pro or Business tier. Please upgrade your license.' };
    }
    if (!data.loanId || !data.itemType || !data.estimatedValue) return { success: false, error: 'Missing required fields' };
    db.run(`INSERT INTO collateral (clientId, loanId, itemType, description, estimatedValue, acceptedValue, imagePaths, documentPath, consentGiven, consentDate, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`, 
      [data.clientId, data.loanId, data.itemType, data.description || '', data.estimatedValue, data.acceptedValue || data.estimatedValue, JSON.stringify(data.imagePaths || []), data.documentPath || '', data.consentGiven ? 1 : 0, data.consentDate || null, data.notes || '']);
    const res = db.exec(`SELECT last_insert_rowid() as id`);
    const newId = res[0]?.values[0]?.[0] || Date.now();
    logAudit('CREATE', 'collateral', newId, null, JSON.stringify(data));
    saveDB();
    return { success: true, id: newId };
  },
  getCollateralByLoan: (loanId) => { 
    const res = db.exec(`SELECT * FROM collateral WHERE loanId = ? AND status != 'deleted' ORDER BY created_at DESC`, [loanId]);
    if (!res[0]) return [];
    return res[0].values.map(row => ({
      id: row[0], clientId: row[1], loanId: row[2], itemType: row[3], description: row[4], estimatedValue: row[5], acceptedValue: row[6], status: row[7], imagePaths: row[8] ? JSON.parse(row[8]) : [], documentPath: row[9], consentGiven: row[10], consentDate: row[11], forfeitDate: row[12], notes: row[13], created_at: row[14], updated_at: row[15]
    }));
  },
  getCollateralByClient: (clientId) => { 
    const res = db.exec(`SELECT * FROM collateral WHERE clientId = ? AND status != 'deleted' ORDER BY created_at DESC`, [clientId]);
    if (!res[0]) return [];
    return res[0].values.map(row => ({
      id: row[0], clientId: row[1], loanId: row[2], itemType: row[3], description: row[4], estimatedValue: row[5], acceptedValue: row[6], status: row[7], imagePaths: row[8] ? JSON.parse(row[8]) : [], documentPath: row[9], consentGiven: row[10], consentDate: row[11], forfeitDate: row[12], notes: row[13], created_at: row[14], updated_at: row[15]
    }));
  },
  getAllCollateral: () => { 
    const res = db.exec(`
      SELECT 
        c.id, c.clientId, c.loanId, c.itemType, c.description, 
        c.estimatedValue, c.acceptedValue, c.status, c.imagePaths, 
        c.documentPath, c.consentGiven, c.consentDate, c.forfeitDate, 
        c.notes, c.created_at, c.updated_at,
        cl.clientNumber, cl.name as clientName,
        l.loanNumber, l.status as loanStatus
      FROM collateral c
      LEFT JOIN clients cl ON c.clientId = cl.id
      LEFT JOIN loans l ON c.loanId = l.id
      WHERE c.status != 'deleted'
      ORDER BY c.created_at DESC
    `);
    if (!res[0]) return [];
    return res[0].values.map(row => ({
      id: row[0], clientId: row[1], loanId: row[2], itemType: row[3], description: row[4], 
      estimatedValue: row[5], acceptedValue: row[6], status: row[7], 
      imagePaths: row[8] ? JSON.parse(row[8]) : [], documentPath: row[9], 
      consentGiven: row[10], consentDate: row[11], forfeitDate: row[12], 
      notes: row[13], created_at: row[14], updated_at: row[15],
      clientNumber: row[16], clientName: row[17],
      loanNumber: row[18], loanStatus: row[19]
    }));
  },
  updateCollateral: (id, data) => { 
    const updates = []; const values = [];
    if (data.acceptedValue !== undefined) { updates.push('acceptedValue = ?'); values.push(data.acceptedValue); }
    if (data.consentGiven !== undefined) { updates.push('consentGiven = ?'); values.push(data.consentGiven ? 1 : 0); }
    if (data.consentDate !== undefined) { updates.push('consentDate = ?'); values.push(data.consentDate); }
    if (data.notes !== undefined) { updates.push('notes = ?'); values.push(data.notes); }
    if (data.status !== undefined) { updates.push('status = ?'); values.push(data.status); }
    if (updates.length === 0) return { success: true };
    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    db.run(`UPDATE collateral SET ${updates.join(', ')} WHERE id = ?`, values);
    logAudit('UPDATE', 'collateral', id, null, JSON.stringify(data));
    saveDB();
    return { success: true };
  },
  deleteCollateral: (id) => { 
    db.run(`UPDATE collateral SET status = 'deleted' WHERE id = ?`, [id]);
    logAudit('DELETE', 'collateral', id, null, null);
    saveDB();
    return { success: true };
  },
  forfeitCollateral: (collateralId) => {
    // Get collateral details first
    const res = db.exec(`SELECT loanId, acceptedValue, estimatedValue, itemType FROM collateral WHERE id = ?`, [collateralId]);
    if (!res[0] || !res[0].values[0]) {
      return { success: false, error: 'Collateral not found' };
    }
    
    const loanId = res[0].values[0][0];
    const acceptedValue = res[0].values[0][1] || res[0].values[0][2]; // Use acceptedValue or fall back to estimatedValue
    const itemType = res[0].values[0][3];
    
    if (!loanId) {
      return { success: false, error: 'Collateral not linked to a loan' };
    }
    
    // Add payment to loan using the collateral's accepted value
    db.run(`INSERT INTO payments (loanId, amount, paymentDate, notes) VALUES (?, ?, ?, ?)`, [
      loanId,
      acceptedValue,
      today(),
      `Collateral forfeited: ${itemType} (Collateral ID: ${collateralId})`
    ]);
    logAudit('CREATE', 'payment', null, null, `Forfeit collateral payment: ${acceptedValue}`);
    
    // Update collateral status to forfeited
    db.run(`UPDATE collateral SET status = 'forfeited', forfeitDate = CURRENT_TIMESTAMP WHERE id = ?`, [collateralId]);
    logAudit('UPDATE', 'collateral', collateralId, 'active', 'forfeited');
    
    saveDB();
    return { success: true, paymentAmount: acceptedValue, loanId: loanId };
  },
  // Documents
  addClientDocument: (data) => {
    if (!data || !data.clientId || !data.filePath) {
      return { success: false, error: 'clientId and filePath are required' };
    }
    const fileName = data.fileName || path.basename(data.filePath);
    const documentType = data.documentType || 'general';
    db.run(`INSERT INTO client_documents (clientId, documentType, filePath, fileName, notes) VALUES (?, ?, ?, ?, ?)`, [data.clientId, documentType, data.filePath, fileName, data.notes || '']);
    const res = db.exec(`SELECT last_insert_rowid() as id`);
    const newId = res[0]?.values[0]?.[0] || Date.now();
    logAudit('CREATE', 'client_document', newId, null, JSON.stringify({ clientId: data.clientId, documentType, filePath: data.filePath, fileName }));
    saveDB();
    return { success: true, id: newId, fileName };
  },
  getClientDocuments: (clientId) => {
    const res = db.exec(`SELECT * FROM client_documents WHERE clientId = ? ORDER BY uploadDate DESC, id DESC`, [clientId]);
    if (!res[0]) return [];
    return res[0].values.map(row => ({
      id: row[0],
      clientId: row[1],
      documentType: row[2],
      filePath: row[3],
      fileName: row[4],
      uploadDate: row[5],
      notes: row[6]
    }));
  },
  deleteClientDocument: (id) => {
    const oldRes = db.exec(`SELECT clientId, documentType, filePath, fileName, notes FROM client_documents WHERE id = ?`, [id]);
    if (!oldRes[0] || !oldRes[0].values[0]) {
      return { success: false, error: 'Client document not found' };
    }
    const row = oldRes[0].values[0];
    db.run(`DELETE FROM client_documents WHERE id = ?`, [id]);
    logAudit('DELETE', 'client_document', id, JSON.stringify({ clientId: row[0], documentType: row[1], filePath: row[2], fileName: row[3], notes: row[4] }), null);
    saveDB();
    return { success: true };
  },
  addCompanyDocument: (data) => {
    if (!data || !data.filePath) {
      return { success: false, error: 'filePath is required' };
    }
    const fileName = data.fileName || path.basename(data.filePath);
    const documentType = data.documentType || 'general';
    db.run(`INSERT INTO company_documents (documentType, filePath, fileName, notes) VALUES (?, ?, ?, ?)`, [documentType, data.filePath, fileName, data.notes || '']);
    const res = db.exec(`SELECT last_insert_rowid() as id`);
    const newId = res[0]?.values[0]?.[0] || Date.now();
    logAudit('CREATE', 'company_document', newId, null, JSON.stringify({ documentType, filePath: data.filePath, fileName }));
    saveDB();
    return { success: true, id: newId, fileName };
  },
  getCompanyDocuments: () => {
    const res = db.exec(`SELECT * FROM company_documents ORDER BY uploadDate DESC, id DESC`);
    if (!res[0]) return [];
    return res[0].values.map(row => ({
      id: row[0],
      documentType: row[1],
      filePath: row[2],
      fileName: row[3],
      uploadDate: row[4],
      notes: row[5]
    }));
  },
  deleteCompanyDocument: (id) => {
    const oldRes = db.exec(`SELECT documentType, filePath, fileName, notes FROM company_documents WHERE id = ?`, [id]);
    if (!oldRes[0] || !oldRes[0].values[0]) {
      return { success: false, error: 'Company document not found' };
    }
    const row = oldRes[0].values[0];
    db.run(`DELETE FROM company_documents WHERE id = ?`, [id]);
    logAudit('DELETE', 'company_document', id, JSON.stringify({ documentType: row[0], filePath: row[1], fileName: row[2], notes: row[3] }), null);
    saveDB();
    return { success: true };
  },
  // Accounts & Transactions - FULL IMPLEMENTATION
  addAccount: (data) => { 
    if (!data.accountName || !data.accountType) {
      return { success: false, error: 'Account name and type are required' };
    }
    db.run(`INSERT INTO accounts (accountName, accountType, accountNumber, provider, balance, isActive, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [data.accountName, data.accountType, data.accountNumber || '', data.provider || '', data.balance || 0, 1, data.notes || '']);
    const res = db.exec(`SELECT last_insert_rowid() as id`);
    const newId = res[0]?.values[0]?.[0] || Date.now();
    logAudit('CREATE', 'account', newId, null, JSON.stringify(data));
    saveDB();
    return { success: true, id: newId };
  },
  getAccounts: () => { 
    const res = db.exec(`SELECT * FROM accounts WHERE isActive = 1 ORDER BY created_at DESC`);
    if (!res[0]) return [];
    return res[0].values.map(row => ({
      id: row[0],
      accountName: row[1],
      accountType: row[2],
      accountNumber: row[3],
      provider: row[4],
      balance: row[5],
      isActive: row[6],
      notes: row[7],
      created_at: row[8]
    }));
  },
  updateAccount: (id, data) => {
    db.run(`UPDATE accounts SET accountName = ?, accountType = ?, accountNumber = ?, provider = ?, notes = ? WHERE id = ?`,
      [data.accountName, data.accountType, data.accountNumber, data.provider, data.notes, id]);
    logAudit('UPDATE', 'account', id, null, JSON.stringify(data));
    saveDB();
    return { success: true };
  },
  deleteAccount: (id) => {
    db.run(`UPDATE accounts SET isActive = 0 WHERE id = ?`, [id]);
    logAudit('DELETE', 'account', id, null, null);
    saveDB();
    return { success: true };
  },
  updateAccountBalance: (accountId, amount, add) => { 
    const res = db.exec(`SELECT balance FROM accounts WHERE id = ?`, [accountId]);
    const currentBalance = res[0]?.values[0]?.[0] || 0;
    const newBalance = add ? currentBalance + amount : currentBalance - amount;
    db.run(`UPDATE accounts SET balance = ? WHERE id = ?`, [newBalance, accountId]);
    logAudit('UPDATE', 'account', accountId, `Balance: ${currentBalance}`, `Balance: ${newBalance}`);
    saveDB();
    return { success: true, balance: newBalance };
  },
  addTransaction: (data) => { 
    if (!data.amount || data.amount <= 0) {
      return { success: false, error: 'Invalid transaction amount' };
    }
    db.run(`INSERT INTO transactions (fromAccountId, toAccountId, amount, transactionType, referenceType, referenceId, description, transactionDate, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.fromAccountId || null, data.toAccountId || null, data.amount, data.transactionType || 'transfer', data.referenceType || null, data.referenceId || null, data.description || '', data.transactionDate || today(), data.notes || '']);
    const res = db.exec(`SELECT last_insert_rowid() as id`);
    const newId = res[0]?.values[0]?.[0] || Date.now();
    
    // Update account balances
    if (data.fromAccountId) {
      const fromRes = db.exec(`SELECT balance FROM accounts WHERE id = ?`, [data.fromAccountId]);
      const fromBalance = fromRes[0]?.values[0]?.[0] || 0;
      db.run(`UPDATE accounts SET balance = ? WHERE id = ?`, [fromBalance - data.amount, data.fromAccountId]);
    }
    if (data.toAccountId) {
      const toRes = db.exec(`SELECT balance FROM accounts WHERE id = ?`, [data.toAccountId]);
      const toBalance = toRes[0]?.values[0]?.[0] || 0;
      db.run(`UPDATE accounts SET balance = ? WHERE id = ?`, [toBalance + data.amount, data.toAccountId]);
    }
    
    logAudit('CREATE', 'transaction', newId, null, JSON.stringify(data));
    saveDB();
    return { success: true, id: newId };
  },
  getTransactions: (limit = 100) => { 
    const res = db.exec(`SELECT * FROM transactions ORDER BY transactionDate DESC LIMIT ?`, [limit]);
    if (!res[0]) return [];
    return res[0].values.map(row => ({
      id: row[0],
      fromAccountId: row[1],
      toAccountId: row[2],
      amount: row[3],
      transactionType: row[4],
      referenceType: row[5],
      referenceId: row[6],
      description: row[7],
      transactionDate: row[8],
      notes: row[9]
    }));
  },
  getTransactionsByLoan: (loanId) => { 
    const res = db.exec(`SELECT * FROM transactions WHERE referenceType = 'loan' AND referenceId = ? ORDER BY transactionDate DESC`, [loanId]);
    if (!res[0]) return [];
    return res[0].values.map(row => ({
      id: row[0],
      fromAccountId: row[1],
      toAccountId: row[2],
      amount: row[3],
      transactionType: row[4],
      referenceType: row[5],
      referenceId: row[6],
      description: row[7],
      transactionDate: row[8],
      notes: row[9]
    }));
  },
  // Backup & Balance Sheets - FULL IMPLEMENTATION
  createBackup: (type = 'manual') => { 
    const backupName = `backup_${type}_${Date.now()}`;
    const backupData = db.export();
    const backupString = Buffer.from(backupData).toString('base64');
    db.run(`INSERT INTO backups (backupName, backupType, backupData, notes) VALUES (?, ?, ?, ?)`,
      [backupName, type, backupString, `Backup created at ${new Date().toISOString()}`]);
    const res = db.exec(`SELECT last_insert_rowid() as id`);
    const newId = res[0]?.values[0]?.[0] || Date.now();
    logAudit('CREATE', 'backup', newId, null, backupName);
    saveDB();
    return { success: true, id: newId, name: backupName };
  },
  getBackups: () => { 
    const res = db.exec(`SELECT id, backupName, backupDate, backupType, notes FROM backups ORDER BY backupDate DESC`);
    if (!res[0]) return [];
    return res[0].values.map(row => ({
      id: row[0],
      backupName: row[1],
      backupDate: row[2],
      backupType: row[3],
      notes: row[4]
    }));
  },
  restoreBackup: (backupId) => { 
    const res = db.exec(`SELECT backupData FROM backups WHERE id = ?`, [backupId]);
    if (!res[0] || !res[0].values[0]) {
      return { success: false, error: 'Backup not found' };
    }
    const backupData = res[0].values[0][0];
    const buffer = Buffer.from(backupData, 'base64');
    db.close();
    db = new SQL.Database(buffer);
    logAudit('RESTORE', 'backup', backupId, null, 'Database restored from backup');
    saveDB();
    return { success: true };
  },
  deleteBackup: (backupId) => {
    try {
      db.run(`DELETE FROM backups WHERE id = ?`, [backupId]);
      logAudit('DELETE', 'backup', backupId, null, 'Backup deleted');
      saveDB();
      return { success: true };
    } catch (err) {
      console.error('deleteBackup error:', err);
      return { success: false, error: err.message };
    }
  },
  generateBalanceSheet: (period) => { 
    const periodDate = period || today();
    
    // Calculate total assets
    const accountsRes = db.exec(`SELECT SUM(balance) FROM accounts WHERE isActive = 1`);
    const accountsBalance = accountsRes[0]?.values[0]?.[0] || 0;
    
    const loansRes = db.exec(`SELECT SUM(amount) FROM loans WHERE status = 'pending'`);
    const loansOutstanding = loansRes[0]?.values[0]?.[0] || 0;
    
    const totalAssets = accountsBalance + loansOutstanding;
    
    // For now, liabilities and equity are 0 (can be expanded)
    const totalLiabilities = 0;
    const totalEquity = totalAssets - totalLiabilities;
    
    const data = {
      accountsBalance,
      loansOutstanding,
      totalAssets,
      totalLiabilities,
      totalEquity,
      generatedAt: new Date().toISOString()
    };
    
    db.run(`INSERT INTO balance_sheets (sheetDate, period, totalAssets, totalLiabilities, totalEquity, data) VALUES (?, ?, ?, ?, ?, ?)`,
      [periodDate, period || 'current', totalAssets, totalLiabilities, totalEquity, JSON.stringify(data)]);
    const res = db.exec(`SELECT last_insert_rowid() as id`);
    const newId = res[0]?.values[0]?.[0] || Date.now();
    logAudit('CREATE', 'balance_sheet', newId, null, periodDate);
    saveDB();
    return { success: true, id: newId, data };
  },
  getBalanceSheets: (limit = 10) => { 
    const res = db.exec(`SELECT * FROM balance_sheets ORDER BY sheetDate DESC LIMIT ?`, [limit]);
    if (!res[0]) return [];
    return res[0].values.map(row => ({
      id: row[0],
      sheetDate: row[1],
      period: row[2],
      totalAssets: row[3],
      totalLiabilities: row[4],
      totalEquity: row[5],
      data: row[6] ? JSON.parse(row[6]) : {},
      createdAt: row[7]
    }));
  },

  // ==========================================
  // LOAN ENGINE (v2.3.0) - Enterprise Architecture
  // ==========================================

  /**
   * Create a loan with full installment schedule
   * @param {Object} loanData - Loan input data
   * @returns {Object} Created loan with schedule
   */
  createLoanWithSchedule: (loanData) => {
    try {
      const { clientId, amount, interest, loanType = 'monthly', duration = 1, 
              loanDate, notes, disbursementDate, earlySettlementEnabled = 1,
              officerName, loanPurpose, guarantorName, guarantorPhone, guarantorRelation } = loanData;

      if (!clientId || !amount || amount <= 0) {
        return { success: false, error: 'Client ID and valid amount are required' };
      }

      // Calculate totals based on loan type
      const totalInterest = (amount * interest) / 100;
      const totalPayable = amount + totalInterest;
      
      // Determine frequency and installment amount
      let frequencyDays = 30; // default monthly
      if (loanType === 'weekly') frequencyDays = 7;
      else if (loanType === 'biweekly') frequencyDays = 14;
      else if (loanType === 'bullet') frequencyDays = duration * 30; // bullet = single payment at end

      const installmentCount = loanType === 'bullet' ? 1 : duration;
      const installmentAmount = totalPayable / installmentCount;

      // Generate loan number
      const loanNumber = generateLoanNumber ? generateLoanNumber() : `LN-${Date.now()}`;
      const startDate = loanDate || today();
      
      // Calculate first due date and end due date
      const startDateObj = new Date(startDate);
      const firstDueDate = new Date(startDateObj);
      firstDueDate.setDate(firstDueDate.getDate() + frequencyDays);
      
      const endDueDate = new Date(startDateObj);
      endDueDate.setDate(endDueDate.getDate() + (frequencyDays * installmentCount));

      // Insert loan record with early settlement flag and new fields
      db.run(`INSERT INTO loans (loanNumber, clientId, amount, interest, loanDate, dueDate, status, notes, 
              loanType, duration, frequencyDays, totalPayable, installmentAmount, remainingBalance, 
              nextPaymentDate, missedPayments, daysOverdue, riskLevel, disbursementDate, agreementSigned,
              earlySettlementEnabled, officerName, loanPurpose, guarantorName, guarantorPhone, guarantorRelation)
              VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'low', ?, 0, ?, ?, ?, ?, ?, ?)`,
        [loanNumber, clientId, amount, interest, startDate, endDueDate.toISOString().split('T')[0], 
         notes || '', loanType, duration, frequencyDays, totalPayable, installmentAmount, 
         totalPayable, firstDueDate.toISOString().split('T')[0], disbursementDate || startDate,
         earlySettlementEnabled ? 1 : 0, officerName || null, loanPurpose || null, 
         guarantorName || null, guarantorPhone || null, guarantorRelation || null]);

      const loanIdRes = db.exec(`SELECT last_insert_rowid() as id`);
      const loanId = loanIdRes[0]?.values[0]?.[0];

      if (!loanId) {
        return { success: false, error: 'Failed to create loan record' };
      }

      // Generate installment schedule
      const principalPerInstallment = amount / installmentCount;
      const interestPerInstallment = totalInterest / installmentCount;

      for (let i = 1; i <= installmentCount; i++) {
        const installmentDueDate = new Date(startDateObj);
        installmentDueDate.setDate(installmentDueDate.getDate() + (frequencyDays * i));
        
        db.run(`INSERT INTO loan_installments (loanId, installmentNumber, dueDate, amount, 
                principalPortion, interestPortion, paidAmount, status)
                VALUES (?, ?, ?, ?, ?, ?, 0, 'pending')`,
          [loanId, i, installmentDueDate.toISOString().split('T')[0], 
           installmentAmount, principalPerInstallment, interestPerInstallment]);
      }

      logAudit('CREATE', 'loan', loanId, null, JSON.stringify({
        loanNumber, clientId, amount, interest, loanType, duration, totalPayable, installmentCount,
        officerName, loanPurpose, guarantorName, guarantorPhone, guarantorRelation
      }));
      saveDB();

      // Sync client data
      module.exports.syncClientLoanData(clientId);

      return { 
        success: true, 
        id: loanId, 
        loanNumber,
        totalPayable,
        installmentAmount,
        installmentCount,
        firstDueDate: firstDueDate.toISOString().split('T')[0],
        endDueDate: endDueDate.toISOString().split('T')[0]
      };
    } catch (err) {
      console.error('[LoanEngine] createLoanWithSchedule error:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * Get installment schedule for a loan
   */
  getLoanInstallments: (loanId) => {
    const res = db.exec(`SELECT * FROM loan_installments WHERE loanId = ? ORDER BY installmentNumber ASC`, [loanId]);
    if (!res[0]) return [];
    return res[0].values.map(row => ({
      id: row[0],
      loanId: row[1],
      installmentNumber: row[2],
      dueDate: row[3],
      amount: row[4],
      principalPortion: row[5],
      interestPortion: row[6],
      paidAmount: row[7],
      paidDate: row[8],
      status: row[9],
      lateFee: row[10],
      notes: row[11],
      created_at: row[12]
    }));
  },

  /**
   * Allocate a payment to loan installments (FIFO: oldest first)
   * @param {Object} paymentData - { loanId, amount, paymentDate, notes }
   * @returns {Object} Allocation result
   */
  allocatePayment: (paymentData) => {
    try {
      const { loanId, amount, paymentDate, notes } = paymentData;
      if (!loanId || !amount || amount <= 0) {
        return { success: false, error: 'Loan ID and valid amount are required' };
      }

      let remainingAmount = amount;
      const allocations = [];
      
      // Get unpaid installments (oldest first)
      const installments = db.exec(`
        SELECT id, installmentNumber, dueDate, amount, paidAmount, lateFee
        FROM loan_installments 
        WHERE loanId = ? AND status != 'paid'
        ORDER BY dueDate ASC, installmentNumber ASC
      `, [loanId]);

      if (installments[0]) {
        for (const row of installments[0].values) {
          if (remainingAmount <= 0) break;
          
          const instId = row[0];
          const instNumber = row[1];
          const instDueDate = row[2];
          const instAmount = row[3];
          const instPaid = row[4] || 0;
          const lateFee = row[5] || 0;
          
          const instOwed = (instAmount + lateFee) - instPaid;
          const allocateAmount = Math.min(remainingAmount, instOwed);
          
          if (allocateAmount > 0) {
            const newPaidAmount = instPaid + allocateAmount;
            const newStatus = newPaidAmount >= (instAmount + lateFee) ? 'paid' : 'partial';
            
            db.run(`UPDATE loan_installments SET paidAmount = ?, paidDate = ?, status = ? WHERE id = ?`,
              [newPaidAmount, paymentDate || today(), newStatus, instId]);
            
            allocations.push({
              installmentId: instId,
              installmentNumber: instNumber,
              dueDate: instDueDate,
              allocated: allocateAmount,
              newStatus
            });
            
            remainingAmount -= allocateAmount;
          }
        }
      }

      // Record payment in payments table
      db.run(`INSERT INTO payments (loanId, amount, paymentDate, notes) VALUES (?, ?, ?, ?)`,
        [loanId, amount, paymentDate || today(), notes || `Allocated to ${allocations.length} installment(s)`]);
      
      const paymentIdRes = db.exec(`SELECT last_insert_rowid() as id`);
      const paymentId = paymentIdRes[0]?.values[0]?.[0];

      logAudit('CREATE', 'payment', paymentId, null, JSON.stringify({
        loanId, amount, allocations, remainingAmount
      }));

      // Update loan status
      module.exports.recalculateLoanStatus(loanId);

      saveDB();

      return {
        success: true,
        paymentId,
        totalPaid: amount,
        allocated: amount - remainingAmount,
        overpayment: remainingAmount > 0 ? remainingAmount : 0,
        allocations
      };
    } catch (err) {
      console.error('[LoanEngine] allocatePayment error:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * Recalculate loan status, balance, and risk level
   */
  recalculateLoanStatus: (loanId) => {
    try {
      // Get loan details
      const loanRes = db.exec(`SELECT clientId, amount, interest, totalPayable FROM loans WHERE id = ?`, [loanId]);
      if (!loanRes[0] || !loanRes[0].values[0]) return { success: false, error: 'Loan not found' };
      
      const clientId = loanRes[0].values[0][0];
      const originalAmount = loanRes[0].values[0][1];
      const loanInterest = loanRes[0].values[0][2];
      let totalPayable = loanRes[0].values[0][3] || (originalAmount + (originalAmount * loanInterest / 100));

      // Calculate total paid and penalties
      const paidRes = db.exec(`SELECT COALESCE(SUM(amount), 0) FROM payments WHERE loanId = ?`, [loanId]);
      const totalPaid = paidRes[0]?.values[0]?.[0] || 0;

      const penaltyRes = db.exec(`SELECT COALESCE(SUM(amount), 0) FROM penalties WHERE loanId = ?`, [loanId]);
      const totalPenalties = penaltyRes[0]?.values[0]?.[0] || 0;
      
      totalPayable += totalPenalties;
      const remainingBalance = Math.max(0, totalPayable - totalPaid);

      // Calculate overdue metrics
      const overdueRes = db.exec(`
        SELECT COUNT(*), MIN(dueDate) 
        FROM loan_installments 
        WHERE loanId = ? AND status != 'paid' AND date(dueDate) < date('now')
      `, [loanId]);
      
      const missedPayments = overdueRes[0]?.values[0]?.[0] || 0;
      const oldestOverdue = overdueRes[0]?.values[0]?.[1];
      
      let daysOverdue = 0;
      if (oldestOverdue) {
        const overdueDate = new Date(oldestOverdue);
        const todayDate = new Date();
        daysOverdue = Math.floor((todayDate - overdueDate) / (1000 * 60 * 60 * 24));
      }

      // Calculate risk level based on overdue days and missed payments
      let riskLevel = 'low';
      if (daysOverdue > 90 || missedPayments >= 4) riskLevel = 'critical';
      else if (daysOverdue > 60 || missedPayments >= 3) riskLevel = 'high';
      else if (daysOverdue > 30 || missedPayments >= 2) riskLevel = 'medium';

      // Determine loan status
      let status = 'pending';
      if (remainingBalance <= 0) {
        status = 'paid';
        riskLevel = 'low';
      } else if (daysOverdue > 90) {
        status = 'defaulted';
      } else if (daysOverdue > 0) {
        status = 'overdue';
      }

      // Find next payment date
      const nextPaymentRes = db.exec(`
        SELECT MIN(dueDate) FROM loan_installments 
        WHERE loanId = ? AND status != 'paid'
      `, [loanId]);
      const nextPaymentDate = nextPaymentRes[0]?.values[0]?.[0] || null;

      // Update loan record
      db.run(`UPDATE loans SET 
              remainingBalance = ?, missedPayments = ?, daysOverdue = ?, 
              riskLevel = ?, status = ?, nextPaymentDate = ?
              WHERE id = ?`,
        [remainingBalance, missedPayments, daysOverdue, riskLevel, status, nextPaymentDate, loanId]);

      logAudit('UPDATE', 'loan', loanId, null, JSON.stringify({
        action: 'recalculate', remainingBalance, missedPayments, daysOverdue, riskLevel, status
      }));

      saveDB();

      // Sync client data
      module.exports.syncClientLoanData(clientId);

      return {
        success: true,
        remainingBalance,
        totalPaid,
        totalPenalties,
        missedPayments,
        daysOverdue,
        riskLevel,
        status,
        nextPaymentDate
      };
    } catch (err) {
      console.error('[LoanEngine] recalculateLoanStatus error:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * Assess default status and apply late fees
   */
  assessDefault: (loanId) => {
    try {
      const loan = module.exports.getLoanDetails(loanId);
      if (!loan) return { success: false, error: 'Loan not found' };

      const lateFeeRate = parseFloat(getSetting('late_fee_rate') || '5'); // 5% default
      const gracePeriodDays = parseInt(getSetting('grace_period_days') || '7');
      
      const todayDate = new Date();
      let feesApplied = 0;
      
      // Get overdue installments without late fees applied today
      const overdueInstallments = db.exec(`
        SELECT id, installmentNumber, dueDate, amount, lateFee
        FROM loan_installments 
        WHERE loanId = ? AND status != 'paid' 
        AND date(dueDate) < date('now', '-' || ? || ' days')
      `, [loanId, gracePeriodDays]);

      if (overdueInstallments[0]) {
        for (const row of overdueInstallments[0].values) {
          const instId = row[0];
          const instAmount = row[3];
          const existingLateFee = row[4] || 0;
          
          // Apply late fee only if not already applied (simplified: one-time fee)
          if (existingLateFee === 0) {
            const lateFee = (instAmount * lateFeeRate) / 100;
            db.run(`UPDATE loan_installments SET lateFee = ? WHERE id = ?`, [lateFee, instId]);
            feesApplied++;
            
            // Also add as penalty
            db.run(`INSERT INTO penalties (loanId, amount, reason) VALUES (?, ?, ?)`,
              [loanId, lateFee, `Late fee for installment #${row[1]} (${lateFeeRate}%)`]);
          }
        }
      }

      if (feesApplied > 0) {
        logAudit('AUTO_PENALTY', 'loan', loanId, null, `Applied ${feesApplied} late fees`);
        saveDB();
      }

      // Recalculate loan status after fees
      const status = module.exports.recalculateLoanStatus(loanId);

      return {
        success: true,
        feesApplied,
        newStatus: status
      };
    } catch (err) {
      console.error('[LoanEngine] assessDefault error:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * Sync client aggregate data based on all their loans
   */
  syncClientLoanData: (clientId) => {
    try {
      // Calculate aggregate loan data for client
      const loansRes = db.exec(`
        SELECT 
          COUNT(*) as totalLoans,
          COUNT(CASE WHEN status NOT IN ('paid', 'cancelled') THEN 1 END) as activeLoans,
          COALESCE(SUM(CASE WHEN status NOT IN ('paid', 'cancelled') THEN remainingBalance ELSE 0 END), 0) as totalOwed,
          COALESCE(SUM(amount), 0) as totalBorrowed,
          MAX(daysOverdue) as maxDaysOverdue,
          MAX(CASE WHEN status = 'defaulted' THEN 1 ELSE 0 END) as hasDefault
        FROM loans WHERE clientId = ?
      `, [clientId]);

      if (!loansRes[0] || !loansRes[0].values[0]) {
        return { success: false, error: 'No loan data found' };
      }

      const data = loansRes[0].values[0];
      const totalLoans = data[0] || 0;
      const activeLoans = data[1] || 0;
      const totalOwed = data[2] || 0;
      const totalBorrowed = data[3] || 0;
      const maxDaysOverdue = data[4] || 0;
      const hasDefault = data[5] || 0;

      // Calculate client risk level
      let clientRisk = 'low';
      if (hasDefault || maxDaysOverdue > 90) clientRisk = 'critical';
      else if (maxDaysOverdue > 60) clientRisk = 'high';
      else if (maxDaysOverdue > 30 || activeLoans > 3) clientRisk = 'medium';

      // Calculate credit score adjustment (50 base, +/- based on history)
      const paidLoansRes = db.exec(`SELECT COUNT(*) FROM loans WHERE clientId = ? AND status = 'paid'`, [clientId]);
      const paidLoans = paidLoansRes[0]?.values[0]?.[0] || 0;
      
      let creditScore = 50;
      creditScore += paidLoans * 5; // +5 per paid loan
      creditScore -= hasDefault * 20; // -20 for default
      creditScore -= Math.min(maxDaysOverdue / 3, 30); // -1 per 3 days overdue, max -30
      creditScore = Math.max(0, Math.min(100, creditScore)); // clamp 0-100

      // Determine client status
      let clientStatus = 'active';
      const blacklistRes = db.exec(`SELECT blacklisted FROM clients WHERE id = ?`, [clientId]);
      const isBlacklisted = blacklistRes[0]?.values[0]?.[0] || 0;
      
      if (isBlacklisted) clientStatus = 'blacklisted';
      else if (hasDefault) clientStatus = 'defaulted';
      else if (activeLoans === 0 && totalLoans > 0) clientStatus = 'inactive';

      // Update client record
      db.run(`UPDATE clients SET 
              riskLevel = ?, creditScore = ?, clientStatus = ?, lastActivity = CURRENT_TIMESTAMP
              WHERE id = ?`,
        [clientRisk, creditScore, clientStatus, clientId]);

      logAudit('SYNC', 'client', clientId, null, JSON.stringify({
        activeLoans, totalOwed, creditScore, clientRisk, clientStatus
      }));

      saveDB();

      return {
        success: true,
        clientId,
        totalLoans,
        activeLoans,
        totalOwed,
        totalBorrowed,
        creditScore,
        riskLevel: clientRisk,
        clientStatus
      };
    } catch (err) {
      console.error('[LoanEngine] syncClientLoanData error:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * Run batch assessment on all active loans
   */
  runBatchAssessment: () => {
    try {
      const activeLoans = db.exec(`SELECT id FROM loans WHERE status NOT IN ('paid', 'cancelled')`);
      if (!activeLoans[0]) return { success: true, processed: 0 };

      let processed = 0;
      let feesApplied = 0;

      for (const row of activeLoans[0].values) {
        const loanId = row[0];
        const result = module.exports.assessDefault(loanId);
        if (result.success) {
          processed++;
          feesApplied += result.feesApplied || 0;
        }
      }

      logAudit('BATCH_ASSESSMENT', 'system', null, null, JSON.stringify({
        processed, feesApplied, timestamp: new Date().toISOString()
      }));

      return { success: true, processed, feesApplied };
    } catch (err) {
      console.error('[LoanEngine] runBatchAssessment error:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * Get loan summary with schedule status
   */
  getLoanSummary: (loanId) => {
    try {
      const loan = module.exports.getLoanDetails(loanId);
      if (!loan) return null;

      const installments = module.exports.getLoanInstallments(loanId);
      const paidInstallments = installments.filter(i => i.status === 'paid').length;
      const overdueInstallments = installments.filter(i => 
        i.status !== 'paid' && new Date(i.dueDate) < new Date()
      ).length;

      return {
        ...loan,
        installments,
        scheduleStats: {
          total: installments.length,
          paid: paidInstallments,
          pending: installments.length - paidInstallments,
          overdue: overdueInstallments,
          progressPercent: installments.length > 0 
            ? Math.round((paidInstallments / installments.length) * 100) : 0
        }
      };
    } catch (err) {
      console.error('[LoanEngine] getLoanSummary error:', err);
      return null;
    }
  },

  /**
   * Get all overdue installments across all loans
   */
  getOverdueInstallments: () => {
    const res = db.exec(`
      SELECT 
        i.id, i.loanId, i.installmentNumber, i.dueDate, i.amount, i.paidAmount, i.lateFee, i.status,
        l.loanNumber, l.clientId,
        c.name as clientName, c.clientNumber, c.phone
      FROM loan_installments i
      JOIN loans l ON i.loanId = l.id
      JOIN clients c ON l.clientId = c.id
      WHERE i.status != 'paid' AND date(i.dueDate) < date('now')
      ORDER BY i.dueDate ASC
    `);
    if (!res[0]) return [];
    return res[0].values.map(row => ({
      id: row[0],
      loanId: row[1],
      installmentNumber: row[2],
      dueDate: row[3],
      amount: row[4],
      paidAmount: row[5],
      lateFee: row[6],
      status: row[7],
      loanNumber: row[8],
      clientId: row[9],
      clientName: row[10],
      clientNumber: row[11],
      clientPhone: row[12],
      daysOverdue: Math.floor((new Date() - new Date(row[3])) / (1000 * 60 * 60 * 24))
    }));
  },

  /**
   * Get upcoming installments (due within N days)
   */
  getUpcomingInstallments: (daysAhead = 7) => {
    const res = db.exec(`
      SELECT 
        i.id, i.loanId, i.installmentNumber, i.dueDate, i.amount, i.paidAmount, i.status,
        l.loanNumber, l.clientId,
        c.name as clientName, c.clientNumber, c.phone
      FROM loan_installments i
      JOIN loans l ON i.loanId = l.id
      JOIN clients c ON l.clientId = c.id
      WHERE i.status != 'paid' 
      AND date(i.dueDate) >= date('now') 
      AND date(i.dueDate) <= date('now', '+' || ? || ' days')
      ORDER BY i.dueDate ASC
    `, [daysAhead]);
    if (!res[0]) return [];
    return res[0].values.map(row => ({
      id: row[0],
      loanId: row[1],
      installmentNumber: row[2],
      dueDate: row[3],
      amount: row[4],
      paidAmount: row[5],
      status: row[6],
      loanNumber: row[7],
      clientId: row[8],
      clientName: row[9],
      clientNumber: row[10],
      clientPhone: row[11]
    }));
  },

  // ==============================================
  // EARLY SETTLEMENT SYSTEM
  // ==============================================

  /**
   * Get default early settlement rate tiers
   * Returns discount percentages based on how early the loan is settled
   */
  getDefaultEarlySettlementRates: () => {
    return [
      { minDaysEarly: 180, discountPercent: 15, label: '6+ months early' },
      { minDaysEarly: 90, discountPercent: 10, label: '3-6 months early' },
      { minDaysEarly: 30, discountPercent: 5, label: '1-3 months early' },
      { minDaysEarly: 7, discountPercent: 2, label: '1-4 weeks early' },
      { minDaysEarly: 0, discountPercent: 0, label: 'Less than 1 week' }
    ];
  },

  /**
   * Calculate early settlement details for a loan
   * @param {number} loanId - The loan ID
   * @returns {object} - Settlement details including amounts and applicable discount
   */
  calculateEarlySettlement: (loanId) => {
    try {
      const loan = module.exports.getLoanDetails(loanId);
      if (!loan) return { success: false, error: 'Loan not found' };
      
      if (loan.status === 'paid' || loan.status === 'cancelled') {
        return { success: false, error: 'Loan is already settled or cancelled' };
      }

      // Get unpaid installments
      const installments = module.exports.getLoanInstallments(loanId);
      const unpaidInstallments = installments.filter(i => i.status !== 'paid');
      
      // If no installments exist, calculate based on loan balance
      if (installments.length === 0 || unpaidInstallments.length === 0) {
        // Fall back to simple calculation based on loan balance
        const balance = loan.balance || 0;
        if (balance <= 0) {
          return { success: false, error: 'Loan has no outstanding balance' };
        }
        
        const principal = loan.amount || 0;
        const totalWithInterest = principal + (principal * (loan.interest || 0) / 100);
        const interestPortion = totalWithInterest - principal;
        const paidSoFar = loan.paidAmount || 0;
        const interestPaid = Math.min(interestPortion, paidSoFar);
        const interestRemaining = Math.max(0, interestPortion - interestPaid);
        
        // Calculate days until due date
        const dueDate = new Date(loan.dueDate);
        const today = new Date();
        const daysEarly = Math.max(0, Math.floor((dueDate - today) / (1000 * 60 * 60 * 24)));
        
        // Get settlement rates
        let rates;
        try {
          rates = loan.earlySettlementRates ? JSON.parse(loan.earlySettlementRates) : null;
        } catch (e) { rates = null; }
        if (!rates || !Array.isArray(rates)) {
          rates = module.exports.getDefaultEarlySettlementRates();
        }
        
        // Find applicable discount
        let applicableRate = { discountPercent: 0, label: 'No discount' };
        for (const rate of rates) {
          if (daysEarly >= rate.minDaysEarly) {
            applicableRate = rate;
            break;
          }
        }
        
        // Calculate discount on remaining interest
        const interestDiscount = interestRemaining * (applicableRate.discountPercent / 100);
        const settlementAmount = balance - interestDiscount;
        
        return {
          success: true,
          loanId,
          loanNumber: loan.loanNumber,
          clientName: loan.clientName,
          originalOutstanding: balance,
          principalOutstanding: balance - interestRemaining,
          interestOutstanding: interestRemaining,
          lateFees: loan.penaltiesTotal || 0,
          daysEarly,
          discountPercent: applicableRate.discountPercent,
          discountLabel: applicableRate.label,
          interestDiscount,
          settlementAmount: Math.round(settlementAmount * 100) / 100,
          savings: Math.round(interestDiscount * 100) / 100,
          unpaidInstallments: 0,
          loanEndDate: loan.dueDate,
          calculationMethod: 'balance-based'
        };
      }

      // Calculate total outstanding
      let totalOutstanding = 0;
      let totalPrincipal = 0;
      let totalInterest = 0;
      let totalLateFees = 0;

      for (const inst of unpaidInstallments) {
        const remaining = inst.amount - (inst.paidAmount || 0);
        totalOutstanding += remaining;
        totalLateFees += inst.lateFee || 0;
      }

      // Estimate principal vs interest split (simplified)
      const principalRate = loan.principal / loan.totalAmount;
      totalPrincipal = totalOutstanding * principalRate;
      totalInterest = totalOutstanding - totalPrincipal;

      // Find loan end date (last installment due date)
      const lastInstallment = unpaidInstallments[unpaidInstallments.length - 1];
      const loanEndDate = new Date(lastInstallment.dueDate);
      const today = new Date();
      const daysEarly = Math.max(0, Math.floor((loanEndDate - today) / (1000 * 60 * 60 * 24)));

      // Get settlement rates (custom or default)
      let rates;
      try {
        rates = loan.earlySettlementRates ? JSON.parse(loan.earlySettlementRates) : null;
      } catch (e) {
        rates = null;
      }
      if (!rates || !Array.isArray(rates)) {
        rates = module.exports.getDefaultEarlySettlementRates();
      }

      // Find applicable discount
      let applicableRate = { discountPercent: 0, label: 'No discount' };
      for (const rate of rates) {
        if (daysEarly >= rate.minDaysEarly) {
          applicableRate = rate;
          break;
        }
      }

      // Calculate discount (apply to interest portion only)
      const interestDiscount = totalInterest * (applicableRate.discountPercent / 100);
      const settlementAmount = totalOutstanding - interestDiscount + totalLateFees;

      return {
        success: true,
        loanId,
        loanNumber: loan.loanNumber,
        clientName: loan.clientName,
        originalOutstanding: totalOutstanding,
        principalOutstanding: totalPrincipal,
        interestOutstanding: totalInterest,
        lateFees: totalLateFees,
        daysEarly,
        discountPercent: applicableRate.discountPercent,
        discountLabel: applicableRate.label,
        interestDiscount,
        settlementAmount: Math.round(settlementAmount * 100) / 100,
        savings: Math.round(interestDiscount * 100) / 100,
        unpaidInstallments: unpaidInstallments.length,
        loanEndDate: loanEndDate.toISOString().split('T')[0]
      };
    } catch (err) {
      console.error('[EarlySettlement] calculateEarlySettlement error:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * Get early settlement advisory (preview without committing)
   */
  getEarlySettlementAdvisory: (loanId) => {
    const calc = module.exports.calculateEarlySettlement(loanId);
    if (!calc.success) return calc;
    
    return {
      ...calc,
      advisory: true,
      message: calc.discountPercent > 0
        ? `Pay ${calc.settlementAmount.toFixed(2)} now and save ${calc.savings.toFixed(2)} (${calc.discountPercent}% discount on interest)`
        : `Settlement amount: ${calc.settlementAmount.toFixed(2)} (no early settlement discount applies)`
    };
  },

  /**
   * Apply early settlement to a loan
   * @param {number} loanId - The loan ID
   * @param {number} paymentAmount - Actual payment received
   * @param {string} userId - User applying the settlement
   * @param {string} notes - Optional notes
   * @returns {object} - Result of the settlement
   */
  applyEarlySettlement: (loanId, paymentAmount, userId, notes = '') => {
    try {
      const calc = module.exports.calculateEarlySettlement(loanId);
      if (!calc.success) return calc;

      // Validate payment amount (allow small variance for rounding)
      const minRequired = calc.settlementAmount * 0.99;
      if (paymentAmount < minRequired) {
        return { 
          success: false, 
          error: `Payment amount (${paymentAmount}) is less than required settlement amount (${calc.settlementAmount.toFixed(2)})` 
        };
      }

      const loan = module.exports.getLoanDetails(loanId);
      const installments = module.exports.getLoanInstallments(loanId);
      const unpaidInstallments = installments.filter(i => i.status !== 'paid');

      // Mark all unpaid installments as paid
      for (const inst of unpaidInstallments) {
        db.run(`
          UPDATE loan_installments 
          SET status = 'paid', paidAmount = amount, paidDate = datetime('now')
          WHERE id = ?
        `, [inst.id]);
      }

      // Record the settlement in history
      const historyEntry = {
        date: new Date().toISOString(),
        originalAmount: calc.originalOutstanding,
        settlementAmount: calc.settlementAmount,
        paymentReceived: paymentAmount,
        discount: calc.interestDiscount,
        discountPercent: calc.discountPercent,
        daysEarly: calc.daysEarly,
        userId,
        notes
      };

      // Get existing history
      let history = [];
      try {
        const existing = db.exec(`SELECT earlySettlementHistory FROM loans WHERE id = ?`, [loanId]);
        if (existing[0]?.values[0]?.[0]) {
          history = JSON.parse(existing[0].values[0][0]);
        }
      } catch (e) {}
      history.push(historyEntry);

      // Update loan status and record settlement
      db.run(`
        UPDATE loans 
        SET status = 'paid',
            paidAmount = paidAmount + ?,
            earlySettlementHistory = ?,
            updatedAt = datetime('now')
        WHERE id = ?
      `, [paymentAmount, JSON.stringify(history), loanId]);

      // Record payment
      db.run(`
        INSERT INTO payments (loanId, amount, date, method, notes, createdAt)
        VALUES (?, ?, datetime('now'), 'early_settlement', ?, datetime('now'))
      `, [loanId, paymentAmount, `Early settlement: ${calc.discountPercent}% discount applied. ${notes}`]);

      saveDB();

      // Sync client data
      module.exports.syncClientLoanData(loan.clientId);

      logAudit('EARLY_SETTLEMENT', userId || 'system', null, loanId, JSON.stringify({
        loanNumber: loan.loanNumber,
        clientId: loan.clientId,
        originalOutstanding: calc.originalOutstanding,
        settlementAmount: calc.settlementAmount,
        paymentReceived: paymentAmount,
        discount: calc.interestDiscount,
        discountPercent: calc.discountPercent,
        daysEarly: calc.daysEarly
      }));

      return {
        success: true,
        loanId,
        loanNumber: loan.loanNumber,
        settlementAmount: calc.settlementAmount,
        paymentReceived: paymentAmount,
        discount: calc.interestDiscount,
        discountPercent: calc.discountPercent,
        message: `Loan ${loan.loanNumber} settled early with ${calc.discountPercent}% discount. Saved: ${calc.savings.toFixed(2)}`
      };
    } catch (err) {
      console.error('[EarlySettlement] applyEarlySettlement error:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * Enable/disable early settlement for a loan
   */
  setEarlySettlementEnabled: (loanId, enabled, customRates = null) => {
    try {
      const ratesJson = customRates ? JSON.stringify(customRates) : null;
      db.run(`
        UPDATE loans 
        SET earlySettlementEnabled = ?, earlySettlementRates = ?
        WHERE id = ?
      `, [enabled ? 1 : 0, ratesJson, loanId]);
      saveDB();
      return { success: true };
    } catch (err) {
      console.error('[EarlySettlement] setEarlySettlementEnabled error:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * Get early settlement history for reporting
   */
  getEarlySettlementReport: (startDate = null, endDate = null) => {
    try {
      let query = `
        SELECT id, loanNumber, clientId, earlySettlementHistory 
        FROM loans 
        WHERE earlySettlementHistory IS NOT NULL AND earlySettlementHistory != '[]'
      `;
      const settlements = [];
      const res = db.exec(query);
      
      if (res[0]) {
        for (const row of res[0].values) {
          try {
            const history = JSON.parse(row[3] || '[]');
            for (const entry of history) {
              const entryDate = new Date(entry.date);
              if (startDate && entryDate < new Date(startDate)) continue;
              if (endDate && entryDate > new Date(endDate)) continue;
              settlements.push({
                loanId: row[0],
                loanNumber: row[1],
                clientId: row[2],
                ...entry
              });
            }
          } catch (e) {}
        }
      }

      return {
        success: true,
        settlements,
        totalSavings: settlements.reduce((sum, s) => sum + (s.discount || 0), 0),
        count: settlements.length
      };
    } catch (err) {
      console.error('[EarlySettlement] getEarlySettlementReport error:', err);
      return { success: false, error: err.message, settlements: [] };
    }
  },

  // ===== RESET FUNCTIONS =====
  
  /**
   * Reset only settings (keeps data)
   */
  resetSettings: () => {
    try {
      db.run(`DELETE FROM settings`);
      saveDB();
      logAudit('RESET', 'settings', null, null, 'All settings reset to default');
      return { success: true };
    } catch (err) {
      console.error('[Reset] resetSettings error:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * Factory reset - deletes all data
   */
  factoryReset: () => {
    try {
      logProduction('FACTORY_RESET_INITIATED', { timestamp: new Date().toISOString() });
      
      // Delete all data from all tables
      const tables = [
        'payments', 'penalties', 'collateral', 'loan_installments',
        'loans', 'client_documents', 'clients',
        'audit_log', 'settings', 'company_documents',
        'accounts', 'transactions', 'backups', 'balance_sheets'
      ];
      
      for (const table of tables) {
        try {
          db.run(`DELETE FROM ${table}`);
        } catch (e) {
          console.warn(`[Reset] Could not clear table ${table}:`, e.message);
        }
      }
      
      // Reset auto-increment counters
      try {
        db.run(`DELETE FROM sqlite_sequence`);
      } catch (e) {}
      
      saveDBImmediate(); // Force immediate save
      
      logProduction('FACTORY_RESET_COMPLETE', { timestamp: new Date().toISOString() });
      
      return { success: true, message: 'Factory reset complete' };
    } catch (err) {
      console.error('[Reset] factoryReset error:', err);
      logProduction('FACTORY_RESET_FAILED', { error: err.message });
      return { success: false, error: err.message };
    }
  },

  // ===== EXPENSE TRACKER =====
  addExpense: (data) => {
    try {
      db.run(`INSERT INTO expenses (description, amount, category, expenseDate, payee, reference, notes, tags) VALUES (?,?,?,?,?,?,?,?)`,
        [data.description, data.amount, data.category || 'General', data.expenseDate || new Date().toISOString().slice(0,10), data.payee || '', data.reference || '', data.notes || '', data.tags || '']);
      const res = db.exec(`SELECT last_insert_rowid() as id`);
      const id = res[0]?.values[0]?.[0];
      logAudit('CREATE', 'expense', id, null, JSON.stringify(data));
      saveDB();
      return { success: true, id };
    } catch (e) { return { success: false, error: e.message }; }
  },

  updateExpense: (id, data) => {
    try {
      db.run(`UPDATE expenses SET description=?, amount=?, category=?, expenseDate=?, payee=?, reference=?, notes=?, tags=? WHERE id=?`,
        [data.description, data.amount, data.category || 'General', data.expenseDate, data.payee || '', data.reference || '', data.notes || '', data.tags || '', id]);
      logAudit('UPDATE', 'expense', id, null, JSON.stringify(data));
      saveDB();
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  },

  addExpenseAttachment: (expenseId, fileName, filePath, fileType, fileSize, caption) => {
    try {
      db.run(`INSERT INTO expense_attachments (expenseId, fileName, filePath, fileType, fileSize, caption) VALUES (?,?,?,?,?,?)`,
        [expenseId, fileName, filePath, fileType || '', fileSize || 0, caption || '']);
      const res = db.exec(`SELECT last_insert_rowid() as id`);
      const id = res[0]?.values[0]?.[0];
      logAudit('CREATE', 'expense_attachment', id, null, JSON.stringify({ expenseId, fileName }));
      saveDB();
      return { success: true, id };
    } catch (e) { return { success: false, error: e.message }; }
  },

  getExpenseAttachments: (expenseId) => {
    try {
      const res = db.exec(`SELECT * FROM expense_attachments WHERE expenseId = ? ORDER BY uploadDate ASC`, [expenseId]);
      if (!res[0]) return [];
      const cols = res[0].columns;
      return res[0].values.map(row => { const o = {}; cols.forEach((c, i) => o[c] = row[i]); return o; });
    } catch (e) { return []; }
  },

  deleteExpenseAttachment: (id) => {
    try {
      const res = db.exec(`SELECT filePath FROM expense_attachments WHERE id = ?`, [id]);
      const filePath = res[0]?.values[0]?.[0];
      db.run(`DELETE FROM expense_attachments WHERE id = ?`, [id]);
      logAudit('DELETE', 'expense_attachment', id, null, null);
      saveDB();
      return { success: true, filePath };
    } catch (e) { return { success: false, error: e.message }; }
  },

  getExpenseWithAttachments: (expenseId) => {
    try {
      const eRes = db.exec(`SELECT * FROM expenses WHERE id = ?`, [expenseId]);
      if (!eRes[0]) return null;
      const cols = eRes[0].columns;
      const expense = {};
      cols.forEach((c, i) => expense[c] = eRes[0].values[0][i]);
      const aRes = db.exec(`SELECT * FROM expense_attachments WHERE expenseId = ? ORDER BY uploadDate ASC`, [expenseId]);
      let attachments = [];
      if (aRes[0]) {
        const aCols = aRes[0].columns;
        attachments = aRes[0].values.map(row => { const o = {}; aCols.forEach((c, i) => o[c] = row[i]); return o; });
      }
      return { ...expense, attachments };
    } catch (e) { return null; }
  },

  getExpenseAttachmentCounts: () => {
    try {
      const res = db.exec(`SELECT expenseId, COUNT(*) as cnt FROM expense_attachments GROUP BY expenseId`);
      if (!res[0]) return {};
      const map = {};
      res[0].values.forEach(row => { map[row[0]] = row[1]; });
      return map;
    } catch (e) { return {}; }
  },

  deleteExpense: (id) => {
    try {
      db.run(`DELETE FROM expenses WHERE id = ?`, [id]);
      logAudit('DELETE', 'expense', id, null, null);
      saveDB();
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  },

  getExpenses: (fromDate, toDate) => {
    try {
      let sql = `SELECT * FROM expenses`;
      const params = [];
      if (fromDate && toDate) {
        sql += ` WHERE expenseDate >= ? AND expenseDate <= ?`;
        params.push(fromDate, toDate);
      } else if (fromDate) {
        sql += ` WHERE expenseDate >= ?`;
        params.push(fromDate);
      }
      sql += ` ORDER BY expenseDate DESC`;
      const res = db.exec(sql, params);
      if (!res[0]) return [];
      const cols = res[0].columns;
      return res[0].values.map(row => {
        const obj = {};
        cols.forEach((c, i) => obj[c] = row[i]);
        return obj;
      });
    } catch (e) { return []; }
  },

  // ===== LOAN TEMPLATES =====
  getLoanTemplates: () => {
    try {
      const val = db.exec(`SELECT value FROM settings WHERE key = 'loanTemplates'`);
      if (!val[0]) return [];
      return JSON.parse(val[0].values[0][0] || '[]');
    } catch (e) { return []; }
  },

  saveLoanTemplates: (templates) => {
    try {
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('loanTemplates', ?)`, [JSON.stringify(templates)]);
      saveDB();
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  },

  // ===== UPDATE LOAN EXTRA FIELDS =====
  updateLoanMeta: (loanId, data) => {
    try {
      const fields = [];
      const vals = [];
      if (data.officerName !== undefined) { fields.push('officerName = ?'); vals.push(data.officerName); }
      if (data.loanPurpose !== undefined) { fields.push('loanPurpose = ?'); vals.push(data.loanPurpose); }
      if (data.guarantorName !== undefined) { fields.push('guarantorName = ?'); vals.push(data.guarantorName); }
      if (data.guarantorPhone !== undefined) { fields.push('guarantorPhone = ?'); vals.push(data.guarantorPhone); }
      if (data.guarantorRelation !== undefined) { fields.push('guarantorRelation = ?'); vals.push(data.guarantorRelation); }
      if (data.restructured !== undefined) { fields.push('restructured = ?'); vals.push(data.restructured ? 1 : 0); }
      if (data.restructureNotes !== undefined) { fields.push('restructureNotes = ?'); vals.push(data.restructureNotes); }
      if (!fields.length) return { success: true };
      vals.push(loanId);
      db.run(`UPDATE loans SET ${fields.join(', ')} WHERE id = ?`, vals);
      logAudit('UPDATE', 'loan_meta', loanId, null, JSON.stringify(data));
      saveDB();
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  },
};
