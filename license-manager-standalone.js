/**
 * MIGL License Manager - Standalone Entry Point
 * This file is designed to be packaged into a standalone executable
 * 
 * Usage: Run the exe, it starts the server and opens the browser
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ===== CONFIGURATION =====
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.LICENSE_DATA_DIR || path.join(process.cwd(), 'license-data');
const KEYS_DIR = process.env.LICENSE_KEYS_DIR || path.join(process.cwd(), 'keys');

// Ensure directories exist
[DATA_DIR, KEYS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const LICENSES_DB = path.join(DATA_DIR, 'issued-licenses.json');
const MACHINE_IDS_DB = path.join(DATA_DIR, 'machine-ids.json');

// Security settings
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (() => {
  console.warn('[SECURITY] Using default admin password. Set ADMIN_PASSWORD env var for production.');
  return 'admin123';
})();

const API_RATE_LIMIT = 100;
const RATE_LIMIT_WINDOW = 60000;
const rateLimitStore = new Map();

// Initialize Express
const app = express();

// Initialize data files
if (!fs.existsSync(LICENSES_DB)) {
  fs.writeFileSync(LICENSES_DB, JSON.stringify({ licenses: [] }, null, 2));
}

if (!fs.existsSync(MACHINE_IDS_DB)) {
  fs.writeFileSync(MACHINE_IDS_DB, JSON.stringify({ machineIds: [] }, null, 2));
}

// ===== KEY MANAGEMENT =====
const GENERATOR_CONFIG = {
  curve: 'prime256v1',
  algorithm: 'sha256',
  licenseVersion: 2
};

function getPrivateKey() {
  const keyPath = path.join(KEYS_DIR, 'private.pem');
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, 'utf8');
  }
  // Generate new keys if not found
  const keys = generateKeyPair();
  fs.writeFileSync(keyPath, keys.privateKey);
  fs.writeFileSync(path.join(KEYS_DIR, 'public.pem'), keys.publicKey);
  console.log('[KEYS] Generated new ECDSA key pair');
  return keys.privateKey;
}

function getPublicKey() {
  const keyPath = path.join(KEYS_DIR, 'public.pem');
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, 'utf8');
  }
  getPrivateKey(); // This will generate both keys
  return fs.readFileSync(keyPath, 'utf8');
}

function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: GENERATOR_CONFIG.curve,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return { privateKey, publicKey };
}

// ===== LICENSE TYPES =====
const LICENSE_TYPES = {
  trial: { duration: 30, maxClients: 10, features: ['basic'], price: 0 },
  personal: { duration: 365, maxClients: 50, features: ['basic', 'reports'], price: 29 },
  professional: { duration: 365, maxClients: 500, features: ['basic', 'reports', 'advanced', 'multi-user'], price: 99 },
  enterprise: { duration: 365, maxClients: -1, features: ['basic', 'reports', 'advanced', 'multi-user', 'api', 'priority-support'], price: 299 }
};

// ===== LICENSE GENERATION =====
function generateLicenseKey(machineId, expiryDate, licenseType) {
  const typeConfig = LICENSE_TYPES[licenseType];
  if (!typeConfig) throw new Error('Invalid license type');

  const payload = {
    version: GENERATOR_CONFIG.licenseVersion,
    machineId,
    expiryDate,
    licenseType,
    issuedAt: new Date().toISOString(),
    features: typeConfig.features,
    maxClients: typeConfig.maxClients
  };

  const payloadStr = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadStr).toString('base64');

  const sign = crypto.createSign(GENERATOR_CONFIG.algorithm);
  sign.update(payloadStr);
  const signature = sign.sign(getPrivateKey(), 'base64');

  return {
    licenseKey: `MIG2-${payloadB64}.${signature}`,
    payload,
    signature
  };
}

function validateLicenseKey(licenseKey, machineId) {
  try {
    if (!licenseKey.startsWith('MIG2-')) {
      return { valid: false, error: 'Invalid license format' };
    }

    const [payloadB64, signature] = licenseKey.slice(5).split('.');
    const payloadStr = Buffer.from(payloadB64, 'base64').toString('utf8');
    const payload = JSON.parse(payloadStr);

    // Verify signature
    const verify = crypto.createVerify(GENERATOR_CONFIG.algorithm);
    verify.update(payloadStr);
    if (!verify.verify(getPublicKey(), signature, 'base64')) {
      return { valid: false, error: 'Invalid signature' };
    }

    // Check machine ID
    if (payload.machineId !== machineId) {
      return { valid: false, error: 'Machine ID mismatch' };
    }

    // Check expiry
    const expiry = new Date(payload.expiryDate);
    const now = new Date();
    if (expiry < now) {
      return { valid: false, error: 'License expired' };
    }

    const daysRemaining = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
    return { valid: true, payload, daysRemaining };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// ===== DATABASE HELPERS =====
function readLicenses() {
  try {
    return JSON.parse(fs.readFileSync(LICENSES_DB, 'utf8'));
  } catch (e) {
    return { licenses: [] };
  }
}

function writeLicenses(data) {
  fs.writeFileSync(LICENSES_DB, JSON.stringify(data, null, 2));
}

function readMachineIds() {
  try {
    return JSON.parse(fs.readFileSync(MACHINE_IDS_DB, 'utf8'));
  } catch (e) {
    return { machineIds: [] };
  }
}

function writeMachineIds(data) {
  fs.writeFileSync(MACHINE_IDS_DB, JSON.stringify(data, null, 2));
}

// ===== MIDDLEWARE =====
app.use(express.json());

// Rate limiting
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const key = `${ip}:${Math.floor(Date.now() / RATE_LIMIT_WINDOW)}`;
  const count = (rateLimitStore.get(key) || 0) + 1;
  rateLimitStore.set(key, count);

  if (count > API_RATE_LIMIT) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
}

app.use('/api', rateLimit);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// ===== EMBEDDED HTML DASHBOARD =====
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MIGL License Manager</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #1e1e2e 0%, #2d2d44 100%); color: #e0e0e0; min-height: 100vh; }
        .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
        header { background: rgba(30, 30, 46, 0.9); padding: 20px; border-left: 4px solid #00d4ff; margin-bottom: 30px; border-radius: 8px; }
        h1 { font-size: 28px; color: #00d4ff; margin-bottom: 5px; }
        .subtitle { color: #888; font-size: 14px; }
        .tabs { display: flex; gap: 10px; margin-bottom: 30px; border-bottom: 2px solid #333; }
        .tab-button { padding: 12px 20px; background: none; border: none; color: #888; cursor: pointer; font-size: 16px; border-bottom: 3px solid transparent; transition: all 0.3s; }
        .tab-button:hover { color: #00d4ff; }
        .tab-button.active { color: #00d4ff; border-bottom-color: #00d4ff; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: rgba(50, 50, 70, 0.6); padding: 25px; border-radius: 10px; border-left: 4px solid #00d4ff; }
        .stat-label { color: #888; font-size: 12px; text-transform: uppercase; margin-bottom: 10px; }
        .stat-value { font-size: 32px; font-weight: bold; color: #00d4ff; }
        .form-section { background: rgba(50, 50, 70, 0.6); padding: 25px; border-radius: 10px; margin-bottom: 25px; }
        .form-section h2 { color: #00d4ff; margin-bottom: 20px; }
        .form-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .form-group { display: flex; flex-direction: column; }
        label { color: #aaa; margin-bottom: 8px; font-size: 14px; }
        input, select { padding: 12px; background: rgba(30, 30, 46, 0.8); border: 1px solid #444; color: #e0e0e0; border-radius: 6px; font-size: 14px; }
        input:focus, select:focus { outline: none; border-color: #00d4ff; }
        button { padding: 12px 20px; background: #00d4ff; color: #1e1e2e; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; transition: all 0.3s; }
        button:hover { background: #00a8cc; }
        .button-group { display: flex; gap: 10px; margin-top: 20px; }
        .button-secondary { background: #444; color: #e0e0e0; }
        .button-danger { background: #ff4444; }
        .table-container { background: rgba(50, 50, 70, 0.6); padding: 20px; border-radius: 10px; overflow-x: auto; }
        .table-container h2 { color: #00d4ff; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; }
        th { padding: 15px; text-align: left; color: #00d4ff; border-bottom: 2px solid #00d4ff; background: rgba(30, 30, 46, 0.8); }
        td { padding: 12px 15px; border-bottom: 1px solid #333; }
        .status-active { color: #00c864; }
        .status-expired { color: #ff4444; }
        .status-expiring { color: #ffaa00; }
        .alert { padding: 15px; border-radius: 6px; margin-bottom: 20px; border-left: 4px solid; }
        .alert-success { background: rgba(0,200,100,0.1); border-color: #00c864; color: #00c864; }
        .alert-error { background: rgba(255,68,68,0.1); border-color: #ff4444; color: #ff4444; }
        .license-key { font-family: monospace; font-size: 11px; color: #00d4ff; word-break: break-all; }
        .copy-btn { background: none; border: 1px solid #444; color: #aaa; padding: 4px 8px; font-size: 12px; cursor: pointer; }
        .copy-btn:hover { border-color: #00d4ff; color: #00d4ff; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>🔐 MIGL License Manager</h1>
            <p class="subtitle">Professional License Generation & Management</p>
        </header>
        <div id="alertContainer"></div>
        <div class="tabs">
            <button class="tab-button active" onclick="switchTab('dashboard')">📊 Dashboard</button>
            <button class="tab-button" onclick="switchTab('generate')">➕ Generate</button>
            <button class="tab-button" onclick="switchTab('licenses')">📋 Licenses</button>
        </div>
        <div id="dashboard" class="tab-content active">
            <div class="stats-grid">
                <div class="stat-card"><div class="stat-label">Total Licenses</div><div class="stat-value" id="stat-total">0</div></div>
                <div class="stat-card"><div class="stat-label">Active</div><div class="stat-value" id="stat-active">0</div></div>
                <div class="stat-card"><div class="stat-label">Expiring Soon</div><div class="stat-value" id="stat-expiring">0</div></div>
                <div class="stat-card"><div class="stat-label">Expired</div><div class="stat-value" id="stat-expired">0</div></div>
            </div>
            <div class="table-container">
                <h2>📌 Recent Licenses</h2>
                <table><thead><tr><th>Customer</th><th>Type</th><th>Machine ID</th><th>Expires</th><th>Status</th></tr></thead>
                <tbody id="recentTable"><tr><td colspan="5" style="text-align:center;color:#666">Loading...</td></tr></tbody></table>
            </div>
        </div>
        <div id="generate" class="tab-content">
            <div class="form-section">
                <h2>✨ Generate New License</h2>
                <form id="licenseForm" onsubmit="generateLicense(event)">
                    <div class="form-row">
                        <div class="form-group"><label>Customer Name *</label><input type="text" id="customerName" required></div>
                        <div class="form-group"><label>Machine ID *</label><input type="text" id="machineId" required></div>
                        <div class="form-group"><label>License Type *</label>
                            <select id="licenseType" required>
                                <option value="">-- Select --</option>
                                <option value="trial">Trial (30 days, 10 clients)</option>
                                <option value="personal">Personal (1 year, 50 clients, $29)</option>
                                <option value="professional">Professional (1 year, 500 clients, $99)</option>
                                <option value="enterprise">Enterprise (1 year, Unlimited, $299)</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group"><label>Expiry Date *</label><input type="date" id="expiryDate" required></div>
                    </div>
                    <div class="button-group">
                        <button type="submit">Generate License</button>
                        <button type="reset" class="button-secondary">Clear</button>
                    </div>
                </form>
            </div>
            <div id="generatedResult"></div>
        </div>
        <div id="licenses" class="tab-content">
            <div class="table-container">
                <h2>📋 All Licenses</h2>
                <table><thead><tr><th>Customer</th><th>Type</th><th>Machine ID</th><th>License Key</th><th>Expires</th><th>Actions</th></tr></thead>
                <tbody id="licensesTable"><tr><td colspan="6" style="text-align:center;color:#666">Loading...</td></tr></tbody></table>
            </div>
        </div>
    </div>
    <script>
        const API = '/api';
        function switchTab(name) {
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
            document.getElementById(name).classList.add('active');
            event.target.classList.add('active');
            if (name === 'dashboard') loadDashboard();
            if (name === 'licenses') loadLicenses();
        }
        async function loadDashboard() {
            const stats = await fetch(API + '/stats').then(r => r.json());
            document.getElementById('stat-total').textContent = stats.total_licenses;
            document.getElementById('stat-active').textContent = stats.active;
            document.getElementById('stat-expiring').textContent = stats.expiring_soon;
            document.getElementById('stat-expired').textContent = stats.expired;
            const licenses = await fetch(API + '/licenses').then(r => r.json());
            const tbody = document.getElementById('recentTable');
            if (licenses.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#666">No licenses yet</td></tr>';
            } else {
                tbody.innerHTML = licenses.slice(0, 10).map(l => {
                    const status = getStatus(l.expiryDate);
                    return '<tr><td>' + l.customerName + '</td><td>' + l.licenseType + '</td><td><small>' + l.machineId + '</small></td><td>' + l.expiryDate + '</td><td class="status-' + status.class + '">' + status.text + '</td></tr>';
                }).join('');
            }
        }
        async function loadLicenses() {
            const licenses = await fetch(API + '/licenses').then(r => r.json());
            const tbody = document.getElementById('licensesTable');
            if (licenses.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#666">No licenses yet</td></tr>';
            } else {
                tbody.innerHTML = licenses.map(l => '<tr><td>' + l.customerName + '</td><td>' + l.licenseType + '</td><td><small>' + l.machineId + '</small></td><td><button class="copy-btn" onclick="copyKey(\\'' + l.licenseKey + '\\')">📋 Copy</button></td><td>' + l.expiryDate + '</td><td><button class="button-danger" style="padding:6px 12px;font-size:12px" onclick="deleteLicense(\\'' + l.id + '\\')">Delete</button></td></tr>').join('');
            }
        }
        async function generateLicense(e) {
            e.preventDefault();
            const data = {
                customerName: document.getElementById('customerName').value,
                machineId: document.getElementById('machineId').value,
                licenseType: document.getElementById('licenseType').value,
                expiryDate: document.getElementById('expiryDate').value
            };
            const res = await fetch(API + '/licenses/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
            const result = await res.json();
            if (res.ok) {
                showAlert('License generated!', 'success');
                document.getElementById('generatedResult').innerHTML = '<div class="form-section" style="border-left:4px solid #00c864"><h2>✅ Generated!</h2><div style="background:rgba(0,200,100,0.1);padding:15px;border-radius:6px;margin-top:15px"><strong>License Key:</strong><div class="license-key" style="margin-top:10px;padding:10px;background:rgba(0,0,0,0.3);border-radius:4px">' + result.license.licenseKey + '</div><button class="copy-btn" style="margin-top:10px" onclick="copyKey(\\'' + result.license.licenseKey + '\\')">📋 Copy Key</button></div></div>';
                document.getElementById('licenseForm').reset();
            } else {
                showAlert(result.error, 'error');
            }
        }
        async function deleteLicense(id) {
            if (!confirm('Delete this license?')) return;
            await fetch(API + '/licenses/' + id, { method: 'DELETE' });
            loadLicenses();
            showAlert('Deleted', 'success');
        }
        function copyKey(key) { navigator.clipboard.writeText(key); showAlert('Copied!', 'success'); }
        function getStatus(expiry) {
            const now = new Date(), exp = new Date(expiry);
            if (exp < now) return { class: 'expired', text: '🔴 Expired' };
            const days = Math.ceil((exp - now) / 86400000);
            if (days <= 30) return { class: 'expiring', text: '🟡 ' + days + 'd left' };
            return { class: 'active', text: '🟢 Active' };
        }
        function showAlert(msg, type) {
            const c = document.getElementById('alertContainer');
            const a = document.createElement('div');
            a.className = 'alert alert-' + type;
            a.textContent = msg;
            c.appendChild(a);
            setTimeout(() => a.remove(), 4000);
        }
        document.addEventListener('DOMContentLoaded', () => {
            loadDashboard();
            document.getElementById('expiryDate').valueAsDate = new Date();
        });
    </script>
</body>
</html>`;

// ===== ROUTES =====

// Serve dashboard
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(DASHBOARD_HTML);
});

// API: Stats
app.get('/api/stats', (req, res) => {
  const licenses = readLicenses();
  const now = new Date();
  let active = 0, expired = 0, expiring_soon = 0;

  licenses.licenses.forEach(l => {
    const exp = new Date(l.expiryDate);
    if (exp < now) expired++;
    else {
      active++;
      if ((exp - now) / 86400000 <= 30) expiring_soon++;
    }
  });

  res.json({ total_licenses: licenses.licenses.length, active, expired, expiring_soon });
});

// API: Get licenses
app.get('/api/licenses', (req, res) => {
  const data = readLicenses();
  res.json(data.licenses.sort((a, b) => new Date(b.issuedAt) - new Date(a.issuedAt)));
});

// API: Generate license
app.post('/api/licenses/generate', (req, res) => {
  try {
    const { machineId, expiryDate, licenseType, customerName } = req.body;
    if (!machineId || !expiryDate || !licenseType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const generated = generateLicenseKey(machineId, expiryDate, licenseType);
    const licenses = readLicenses();
    
    const record = {
      id: crypto.randomBytes(8).toString('hex'),
      licenseKey: generated.licenseKey,
      machineId,
      customerName: customerName || 'Unknown',
      licenseType,
      expiryDate,
      issuedAt: new Date().toISOString(),
      features: generated.payload.features,
      maxClients: generated.payload.maxClients,
      price: LICENSE_TYPES[licenseType].price
    };

    licenses.licenses.push(record);
    writeLicenses(licenses);

    res.json({ success: true, license: record });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Delete license
app.delete('/api/licenses/:id', (req, res) => {
  const licenses = readLicenses();
  licenses.licenses = licenses.licenses.filter(l => l.id !== req.params.id);
  writeLicenses(licenses);
  res.json({ success: true });
});

// API: Validate license
app.post('/api/licenses/validate', (req, res) => {
  const { licenseKey, machineId } = req.body;
  const result = validateLicenseKey(licenseKey, machineId);
  res.json(result);
});

// ===== START SERVER =====
function openBrowser(url) {
  const commands = {
    win32: `start "" "${url}"`,
    darwin: `open "${url}"`,
    linux: `xdg-open "${url}"`
  };
  exec(commands[process.platform] || commands.linux);
}

const server = app.listen(PORT, () => {
  console.log('');
  console.log('╔═════════════════════════════════════════════════════╗');
  console.log('║     MIGL License Manager - Standalone Edition       ║');
  console.log('╚═════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`📍 Dashboard: http://localhost:${PORT}`);
  console.log(`📁 Data: ${DATA_DIR}`);
  console.log(`🔑 Keys: ${KEYS_DIR}`);
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('');

  // Auto-open browser
  setTimeout(() => openBrowser(`http://localhost:${PORT}`), 1000);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is in use. Try: SET PORT=3001`);
    process.exit(1);
  }
  throw err;
});
