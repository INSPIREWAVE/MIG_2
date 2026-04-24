/**
 * MIGL License Manager - Backend Server
 * Node.js Express server for managing licenses
 * 
 * Features:
 * - Generate licenses via UI
 * - Track issued licenses
 * - Monitor expiry dates
 * - Manage machine IDs
 * - REST API for all operations
 * - Rate limiting for security
 * - Basic authentication support
 * 
 * SECURITY: Set environment variables for production:
 *   ADMIN_USERNAME - Admin username (default: admin)
 *   ADMIN_PASSWORD - Admin password (default: admin123)
 *   API_RATE_LIMIT - Requests per minute (default: 60)
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// ===== SECURITY CONFIGURATION =====
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (() => {
  console.warn('[SECURITY] Using default admin password. Set ADMIN_PASSWORD env var for production.');
  return 'admin123';
})();
const API_RATE_LIMIT = parseInt(process.env.API_RATE_LIMIT) || 60; // requests per minute
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute

// Rate limiter store
const rateLimitStore = new Map();

// ===== CONFIGURATION =====
const DATA_DIR = './license-data';
const LICENSES_DB = path.join(DATA_DIR, 'issued-licenses.json');
const MACHINE_IDS_DB = path.join(DATA_DIR, 'machine-ids.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize databases if they don't exist
if (!fs.existsSync(LICENSES_DB)) {
  fs.writeFileSync(LICENSES_DB, JSON.stringify({ licenses: [] }, null, 2));
}

if (!fs.existsSync(MACHINE_IDS_DB)) {
  fs.writeFileSync(MACHINE_IDS_DB, JSON.stringify({ machineIds: [] }, null, 2));
}

// ===== MIDDLEWARE =====
app.use(express.json());

// Serve the license manager HTML on root path (MUST be before static middleware)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'license-manager.html'));
});

// Static file serving (after root route to prevent index.html override)
app.use(express.static(__dirname, { index: false }));

// Rate limiting middleware
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const key = `${ip}:${Math.floor(Date.now() / RATE_LIMIT_WINDOW)}`;
  
  const count = (rateLimitStore.get(key) || 0) + 1;
  rateLimitStore.set(key, count);
  
  // Cleanup old entries
  if (rateLimitStore.size > 1000) {
    const now = Date.now();
    for (const [k] of rateLimitStore) {
      const windowTime = parseInt(k.split(':')[1]) * RATE_LIMIT_WINDOW;
      if (now - windowTime > RATE_LIMIT_WINDOW * 2) {
        rateLimitStore.delete(k);
      }
    }
  }
  
  if (count > API_RATE_LIMIT) {
    return res.status(429).json({ 
      error: 'Too many requests',
      retryAfter: Math.ceil(RATE_LIMIT_WINDOW / 1000)
    });
  }
  
  res.setHeader('X-RateLimit-Limit', API_RATE_LIMIT);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, API_RATE_LIMIT - count));
  next();
}

// Basic authentication middleware (optional, for admin endpoints)
function basicAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="License Manager"');
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
  const [username, password] = credentials.split(':');
  
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Invalid credentials' });
  }
  
  next();
}

// Apply rate limiting to all API routes
app.use('/api', rateLimit);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// ===== DATABASE HELPERS =====

function readLicenses() {
  try {
    const data = fs.readFileSync(LICENSES_DB, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return { licenses: [] };
  }
}

function writeLicenses(data) {
  fs.writeFileSync(LICENSES_DB, JSON.stringify(data, null, 2));
}

function readMachineIds() {
  try {
    const data = fs.readFileSync(MACHINE_IDS_DB, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return { machineIds: [] };
  }
}

function writeMachineIds(data) {
  fs.writeFileSync(MACHINE_IDS_DB, JSON.stringify(data, null, 2));
}

// ===== LICENSE GENERATOR INTEGRATION =====

function generateLicenseKey(machineId, expiryDate, licenseType) {
  try {
    const generator = require('./license-generator-v2.js');
    const result = generator.generateLicense(machineId, expiryDate, licenseType);
    return result;
  } catch (error) {
    throw new Error(`License generation failed: ${error.message}`);
  }
}

function validateLicenseKey(licenseKey, machineId) {
  try {
    const generator = require('./license-generator-v2.js');
    const result = generator.validateLicense(licenseKey, machineId);
    return result;
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// ===== API ENDPOINTS =====

// Get dashboard stats
app.get('/api/stats', (req, res) => {
  const licenses = readLicenses();
  const now = new Date();
  
  let active = 0, expired = 0, expiring_soon = 0;
  
  licenses.licenses.forEach(license => {
    const expiry = new Date(license.expiryDate);
    if (expiry < now) {
      expired++;
    } else {
      const days = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
      if (days <= 30) {
        expiring_soon++;
      }
      active++;
    }
  });
  
  res.json({
    total_licenses: licenses.licenses.length,
    active,
    expired,
    expiring_soon,
    total_revenue: licenses.licenses.reduce((sum, l) => sum + (l.price || 0), 0)
  });
});

// Get all licenses
app.get('/api/licenses', (req, res) => {
  const data = readLicenses();
  const sorted = data.licenses.sort((a, b) => new Date(b.issuedAt) - new Date(a.issuedAt));
  res.json(sorted);
});

// Get licenses expiring soon (next 30 days)
app.get('/api/licenses/expiring-soon', (req, res) => {
  const data = readLicenses();
  const now = new Date();
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  
  const expiring = data.licenses.filter(license => {
    const expiry = new Date(license.expiryDate);
    return expiry >= now && expiry <= thirtyDaysFromNow;
  });
  
  res.json(expiring.sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate)));
});

// Generate new license
app.post('/api/licenses/generate', (req, res) => {
  try {
    const { machineId, expiryDate, licenseType, customerName } = req.body;
    
    if (!machineId || !expiryDate || !licenseType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Generate the license
    const generated = generateLicenseKey(machineId, expiryDate, licenseType);
    
    if (!generated.licenseKey) {
      return res.status(400).json({ error: 'Failed to generate license key' });
    }
    
    // Save to database
    const licenses = readLicenses();
    const licenseRecord = {
      id: crypto.randomBytes(8).toString('hex'),
      licenseKey: generated.licenseKey,
      machineId,
      customerName: customerName || 'Unnamed Customer',
      licenseType,
      expiryDate,
      issuedAt: new Date().toISOString(),
      status: 'active',
      features: generated.payload.features,
      maxClients: generated.payload.maxClients,
      price: getLicensePrice(licenseType),
      validationStatus: 'verified'
    };
    
    licenses.licenses.push(licenseRecord);
    writeLicenses(licenses);
    
    // Track machine ID
    const machines = readMachineIds();
    if (!machines.machineIds.find(m => m.id === machineId)) {
      machines.machineIds.push({
        id: machineId,
        customerName: customerName || 'Unnamed Customer',
        addedAt: new Date().toISOString(),
        licenseCount: 1
      });
    } else {
      const machine = machines.machineIds.find(m => m.id === machineId);
      machine.licenseCount = (machine.licenseCount || 0) + 1;
    }
    writeMachineIds(machines);
    
    res.json({
      success: true,
      license: licenseRecord,
      message: 'License generated successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Validate license
app.post('/api/licenses/validate', (req, res) => {
  try {
    const { licenseKey, machineId } = req.body;
    
    if (!licenseKey || !machineId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const validation = validateLicenseKey(licenseKey, machineId);
    
    // Update validation status in database if license is found
    if (validation.valid) {
      const licenses = readLicenses();
      const license = licenses.licenses.find(l => l.licenseKey === licenseKey);
      if (license) {
        license.validationStatus = 'verified';
        license.lastValidatedAt = new Date().toISOString();
        writeLicenses(licenses);
      }
    }
    
    res.json(validation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete license
app.delete('/api/licenses/:id', (req, res) => {
  try {
    const { id } = req.params;
    const licenses = readLicenses();
    
    const licenseIndex = licenses.licenses.findIndex(l => l.id === id);
    if (licenseIndex === -1) {
      return res.status(404).json({ error: 'License not found' });
    }
    
    const removed = licenses.licenses.splice(licenseIndex, 1)[0];
    writeLicenses(licenses);
    
    res.json({ success: true, deleted: removed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all machine IDs
app.get('/api/machine-ids', (req, res) => {
  const data = readMachineIds();
  const sorted = data.machineIds.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  res.json(sorted);
});

// Add manual machine ID
app.post('/api/machine-ids', (req, res) => {
  try {
    const { machineId, customerName } = req.body;
    
    if (!machineId) {
      return res.status(400).json({ error: 'Machine ID is required' });
    }
    
    const machines = readMachineIds();
    
    if (machines.machineIds.find(m => m.id === machineId)) {
      return res.status(400).json({ error: 'Machine ID already exists' });
    }
    
    machines.machineIds.push({
      id: machineId,
      customerName: customerName || 'Unnamed Customer',
      addedAt: new Date().toISOString(),
      licenseCount: 0
    });
    
    writeMachineIds(machines);
    
    res.json({ success: true, message: 'Machine ID added' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete machine ID
app.delete('/api/machine-ids/:id', (req, res) => {
  try {
    const { id } = req.params;
    const machines = readMachineIds();
    
    const index = machines.machineIds.findIndex(m => m.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Machine ID not found' });
    }
    
    const removed = machines.machineIds.splice(index, 1)[0];
    writeMachineIds(machines);
    
    res.json({ success: true, deleted: removed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate bulk licenses
app.post('/api/licenses/bulk-generate', (req, res) => {
  try {
    const { licenses: licensesToGenerate } = req.body;
    
    if (!Array.isArray(licensesToGenerate) || licensesToGenerate.length === 0) {
      return res.status(400).json({ error: 'No licenses provided' });
    }
    
    const results = [];
    const licenses = readLicenses();
    
    licensesToGenerate.forEach(config => {
      try {
        const generated = generateLicenseKey(
          config.machineId,
          config.expiryDate,
          config.licenseType
        );
        
        const licenseRecord = {
          id: crypto.randomBytes(8).toString('hex'),
          licenseKey: generated.licenseKey,
          machineId: config.machineId,
          customerName: config.customerName || 'Bulk Generated',
          licenseType: config.licenseType,
          expiryDate: config.expiryDate,
          issuedAt: new Date().toISOString(),
          status: 'active',
          features: generated.payload.features,
          maxClients: generated.payload.maxClients,
          price: getLicensePrice(config.licenseType),
          validationStatus: 'verified'
        };
        
        licenses.licenses.push(licenseRecord);
        results.push({ success: true, record: licenseRecord });
      } catch (error) {
        results.push({ success: false, machineId: config.machineId, error: error.message });
      }
    });
    
    writeLicenses(licenses);
    
    res.json({
      success: true,
      total: licensesToGenerate.length,
      generated: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Export licenses as JSON
app.get('/api/licenses/export/json', (req, res) => {
  try {
    const licenses = readLicenses();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="licenses-export.json"');
    res.json(licenses.licenses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Export licenses as CSV
app.get('/api/licenses/export/csv', (req, res) => {
  try {
    const licenses = readLicenses();
    
    const headers = ['ID', 'Customer Name', 'License Type', 'Machine ID', 'Issued Date', 'Expiry Date', 'Status', 'Max Clients', 'Price'];
    const rows = licenses.licenses.map(l => [
      l.id,
      l.customerName,
      l.licenseType,
      l.machineId,
      l.issuedAt,
      l.expiryDate,
      l.status,
      l.maxClients,
      l.price
    ]);
    
    const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="licenses-export.csv"');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== LICENSE RENEWAL =====

// Renew an existing license
app.post('/api/licenses/:id/renew', (req, res) => {
  try {
    const { id } = req.params;
    const { newExpiryDate, extendDays } = req.body;
    
    const licenses = readLicenses();
    const license = licenses.licenses.find(l => l.id === id);
    
    if (!license) {
      return res.status(404).json({ error: 'License not found' });
    }
    
    // Calculate new expiry date
    let newExpiry;
    if (newExpiryDate) {
      newExpiry = new Date(newExpiryDate);
    } else if (extendDays) {
      const currentExpiry = new Date(license.expiryDate);
      const now = new Date();
      const baseDate = currentExpiry > now ? currentExpiry : now;
      newExpiry = new Date(baseDate.getTime() + (extendDays * 24 * 60 * 60 * 1000));
    } else {
      return res.status(400).json({ error: 'Provide newExpiryDate or extendDays' });
    }
    
    if (isNaN(newExpiry.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    
    // Generate new license key with updated expiry
    const generated = generateLicenseKey(license.machineId, newExpiry.toISOString().split('T')[0], license.licenseType);
    
    // Update license record
    const oldLicenseKey = license.licenseKey;
    license.licenseKey = generated.licenseKey;
    license.expiryDate = newExpiry.toISOString().split('T')[0];
    license.renewedAt = new Date().toISOString();
    license.renewalCount = (license.renewalCount || 0) + 1;
    license.status = 'active';
    license.previousLicenseKey = oldLicenseKey;
    
    writeLicenses(licenses);
    
    res.json({
      success: true,
      message: 'License renewed successfully',
      license: {
        ...license,
        newLicenseKey: generated.licenseKey
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== LICENSE REVOCATION =====

// Revoke a license
app.post('/api/licenses/:id/revoke', (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    const licenses = readLicenses();
    const license = licenses.licenses.find(l => l.id === id);
    
    if (!license) {
      return res.status(404).json({ error: 'License not found' });
    }
    
    if (license.status === 'revoked') {
      return res.status(400).json({ error: 'License is already revoked' });
    }
    
    license.status = 'revoked';
    license.revokedAt = new Date().toISOString();
    license.revokeReason = reason || 'No reason provided';
    
    writeLicenses(licenses);
    
    res.json({
      success: true,
      message: 'License revoked successfully',
      license
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reactivate a revoked license
app.post('/api/licenses/:id/reactivate', (req, res) => {
  try {
    const { id } = req.params;
    
    const licenses = readLicenses();
    const license = licenses.licenses.find(l => l.id === id);
    
    if (!license) {
      return res.status(404).json({ error: 'License not found' });
    }
    
    if (license.status !== 'revoked') {
      return res.status(400).json({ error: 'License is not revoked' });
    }
    
    // Check if license is expired
    const expiry = new Date(license.expiryDate);
    if (expiry < new Date()) {
      return res.status(400).json({ 
        error: 'Cannot reactivate expired license. Use renewal instead.',
        expiryDate: license.expiryDate
      });
    }
    
    license.status = 'active';
    license.reactivatedAt = new Date().toISOString();
    delete license.revokeReason;
    
    writeLicenses(licenses);
    
    res.json({
      success: true,
      message: 'License reactivated successfully',
      license
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== LICENSE TRANSFER =====

// Transfer license to new machine
app.post('/api/licenses/:id/transfer', (req, res) => {
  try {
    const { id } = req.params;
    const { newMachineId, reason } = req.body;
    
    if (!newMachineId || newMachineId.length < 8) {
      return res.status(400).json({ error: 'New Machine ID must be at least 8 characters' });
    }
    
    const licenses = readLicenses();
    const license = licenses.licenses.find(l => l.id === id);
    
    if (!license) {
      return res.status(404).json({ error: 'License not found' });
    }
    
    if (license.status === 'revoked') {
      return res.status(400).json({ error: 'Cannot transfer revoked license' });
    }
    
    // Check if license is expired
    const expiry = new Date(license.expiryDate);
    if (expiry < new Date()) {
      return res.status(400).json({ error: 'Cannot transfer expired license' });
    }
    
    // Store old machine ID for audit
    const oldMachineId = license.machineId;
    
    // Generate new license key for new machine
    const generated = generateLicenseKey(newMachineId, license.expiryDate, license.licenseType);
    
    // Update license
    license.machineId = newMachineId;
    license.licenseKey = generated.licenseKey;
    license.transferredAt = new Date().toISOString();
    license.transferCount = (license.transferCount || 0) + 1;
    license.transferHistory = license.transferHistory || [];
    license.transferHistory.push({
      fromMachineId: oldMachineId,
      toMachineId: newMachineId,
      transferredAt: new Date().toISOString(),
      reason: reason || 'No reason provided'
    });
    
    writeLicenses(licenses);
    
    // Update machine tracking
    const machines = readMachineIds();
    const oldMachine = machines.machineIds.find(m => m.id === oldMachineId);
    if (oldMachine) {
      oldMachine.licenseCount = Math.max(0, (oldMachine.licenseCount || 1) - 1);
    }
    
    let newMachine = machines.machineIds.find(m => m.id === newMachineId);
    if (!newMachine) {
      machines.machineIds.push({
        id: newMachineId,
        customerName: license.customerName,
        addedAt: new Date().toISOString(),
        licenseCount: 1
      });
    } else {
      newMachine.licenseCount = (newMachine.licenseCount || 0) + 1;
    }
    writeMachineIds(machines);
    
    res.json({
      success: true,
      message: 'License transferred successfully',
      license: {
        ...license,
        newLicenseKey: generated.licenseKey
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== SEARCH & FILTER =====

// Search licenses
app.get('/api/licenses/search', (req, res) => {
  try {
    const { q, status, type, customer } = req.query;
    let licenses = readLicenses().licenses;
    
    // Filter by search query
    if (q) {
      const query = q.toLowerCase();
      licenses = licenses.filter(l => 
        l.customerName?.toLowerCase().includes(query) ||
        l.machineId?.toLowerCase().includes(query) ||
        l.licenseKey?.toLowerCase().includes(query) ||
        l.id?.toLowerCase().includes(query)
      );
    }
    
    // Filter by status
    if (status) {
      licenses = licenses.filter(l => l.status === status);
    }
    
    // Filter by license type
    if (type) {
      licenses = licenses.filter(l => l.licenseType === type);
    }
    
    // Filter by customer name
    if (customer) {
      licenses = licenses.filter(l => 
        l.customerName?.toLowerCase().includes(customer.toLowerCase())
      );
    }
    
    res.json(licenses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update license customer info
app.patch('/api/licenses/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { customerName, notes } = req.body;
    
    const licenses = readLicenses();
    const license = licenses.licenses.find(l => l.id === id);
    
    if (!license) {
      return res.status(404).json({ error: 'License not found' });
    }
    
    if (customerName) license.customerName = customerName;
    if (notes !== undefined) license.notes = notes;
    license.updatedAt = new Date().toISOString();
    
    writeLicenses(licenses);
    
    res.json({ success: true, license });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== HELPER FUNCTIONS =====

function getLicensePrice(licenseType) {
  const prices = {
    trial: 0,
    personal: 29,
    professional: 99,
    enterprise: 299
  };
  return prices[licenseType] || 0;
}

// ===== SERVER START =====

const server = app.listen(PORT, () => {
  console.log('\n╔═════════════════════════════════════════════════════╗');
  console.log('║     MIGL License Manager - Server Running           ║');
  console.log('╚═════════════════════════════════════════════════════╝\n');
  console.log(`📍 Open your browser and go to: http://localhost:${PORT}`);
  console.log(`\n📊 Dashboard: http://localhost:${PORT}`);
  console.log(`📋 API Base: http://localhost:${PORT}/api`);
  console.log(`\n📁 Data stored in: ${DATA_DIR}`);
  console.log(`\n Press Ctrl+C to stop the server\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Error: Port ${PORT} is already in use.`);
    console.error(`   Try a different port: SET PORT=3001 && node license-manager-server.js`);
  } else {
    console.error(`\n❌ Server error: ${err.message}`);
  }
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n✓ Server stopped');
  process.exit(0);
});
