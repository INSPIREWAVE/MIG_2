/**
 * MIGL License Generator v2.0 - Improved Cryptographic Version
 * Uses ECDSA (Elliptic Curve Digital Signature Algorithm) for secure license validation
 * 
 * IMPROVEMENTS:
 * - Asymmetric cryptography (ECDSA P-256)
 * - Digital signatures instead of simple hashes
 * - No hardcoded secrets embedded in app
 * - License metadata included in signature
 * - Tamper detection via signature verification
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ===== CONFIGURATION =====
const GENERATOR_CONFIG = {
  curve: 'prime256v1', // Standard ECDSA curve (P-256/secp256r1)
  algorithm: 'sha256',
  licenseVersion: 2
};

// License types and their features
const LICENSE_TYPES = {
  trial: {
    duration: 30,
    maxClients: 10,
    features: ['basic'],
    price: 0
  },
  personal: {
    duration: 365,
    maxClients: 50,
    features: ['basic', 'reports'],
    price: 29
  },
  professional: {
    duration: 365,
    maxClients: 500,
    features: ['basic', 'reports', 'advanced', 'multi-user'],
    price: 99
  },
  enterprise: {
    duration: 365,
    maxClients: -1,
    features: ['basic', 'reports', 'advanced', 'multi-user', 'api', 'priority-support'],
    price: 299
  }
};

// ===== KEY MANAGEMENT =====

/**
 * Generate a new ECDSA key pair for license signing
 * Save private key securely (only in license generator)
 * Distribute public key to app
 */
function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: GENERATOR_CONFIG.curve,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  return {
    privateKey,
    publicKey,
    generatedAt: new Date().toISOString(),
    curve: GENERATOR_CONFIG.curve
  };
}

/**
 * Save private key to secure file (generator only)
 * @param {string} privateKey - PEM-encoded private key
 * @param {string} outputPath - Where to save (default: ./keys/private.pem)
 */
function savePrivateKey(privateKey, outputPath = './keys/private.pem') {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  fs.writeFileSync(outputPath, privateKey, { mode: 0o600 }); // Read/write for owner only
  console.log(`✓ Private key saved to ${outputPath} (0600 permissions)`);
}

/**
 * Save public key to include in app
 * @param {string} publicKey - PEM-encoded public key
 * @param {string} outputPath - Where to save (default: ./keys/public.pem)
 */
function savePublicKey(publicKey, outputPath = './keys/public.pem') {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  fs.writeFileSync(outputPath, publicKey);
  console.log(`✓ Public key saved to ${outputPath} (can be distributed to app)`);
}

/**
 * Load private key from file (for license generation)
 */
function loadPrivateKey(keyPath = './keys/private.pem') {
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Private key not found at ${keyPath}. Run --generate-keys first.`);
  }
  return fs.readFileSync(keyPath, 'utf8');
}

/**
 * Load public key from file (for validation in app)
 */
function loadPublicKey(keyPath = './keys/public.pem') {
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Public key not found at ${keyPath}`);
  }
  return fs.readFileSync(keyPath, 'utf8');
}

// ===== LICENSE GENERATION =====

/**
 * Create license payload (data to be signed)
 */
function createLicensePayload(machineId, expiryDate, licenseType) {
  return {
    version: GENERATOR_CONFIG.licenseVersion,
    machineId,
    expiryDate,
    licenseType,
    issuedAt: new Date().toISOString(),
    features: LICENSE_TYPES[licenseType].features,
    maxClients: LICENSE_TYPES[licenseType].maxClients
  };
}

/**
 * Sign license payload with private key
 */
function signLicense(payload, privateKey) {
  const sign = crypto.createSign(GENERATOR_CONFIG.algorithm);
  sign.update(JSON.stringify(payload));
  
  const signature = sign.sign(
    {
      key: privateKey,
      format: 'pem'
    },
    'hex'
  );
  
  return signature;
}

/**
 * Generate a signed license key
 * @param {string} machineId - Unique machine identifier
 * @param {string} expiryDate - Expiration date in YYYY-MM-DD format
 * @param {string} licenseType - One of: trial, personal, professional, enterprise
 * @param {string} privateKeyPath - Path to private key file
 * @returns {object} License with signature
 */
function generateLicense(machineId, expiryDate, licenseType = 'trial', privateKeyPath = './keys/private.pem') {
  // Validation
  if (!machineId || machineId.length < 8) {
    throw new Error('Machine ID must be at least 8 characters long');
  }
  
  if (!LICENSE_TYPES[licenseType]) {
    throw new Error(`Invalid license type. Must be one of: ${Object.keys(LICENSE_TYPES).join(', ')}`);
  }
  
  const expiry = new Date(expiryDate);
  if (isNaN(expiry.getTime())) {
    throw new Error('Invalid expiry date. Use YYYY-MM-DD format');
  }
  
  // Create and sign payload
  const payload = createLicensePayload(machineId, expiryDate, licenseType);
  const privateKey = loadPrivateKey(privateKeyPath);
  const signature = signLicense(payload, privateKey);
  
  // Encode as compact license key: payload_base64.signature_base64
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signatureB64 = Buffer.from(signature, 'hex').toString('base64');
  const licenseKey = `MIG2-${payloadB64}.${signatureB64}`;
  
  return {
    licenseKey,
    payload,
    signature,
    generatedAt: new Date().toISOString(),
    isValid: true
  };
}

// ===== LICENSE VALIDATION =====

/**
 * Validate a signed license key
 * @param {string} licenseKey - License key to validate
 * @param {string} machineId - Machine ID to validate against
 * @param {string} publicKeyPath - Path to public key file
 * @returns {object} Validation result
 */
function validateLicense(licenseKey, machineId, publicKeyPath = './keys/public.pem') {
  try {
    // Parse license key
    if (!licenseKey.startsWith('MIG2-')) {
      return { 
        valid: false, 
        error: 'Invalid license key format (expected MIG2-)',
        version: 1 // Old format
      };
    }
    
    const parts = licenseKey.substring(5).split('.');
    if (parts.length !== 2) {
      return { valid: false, error: 'Invalid license key structure' };
    }
    
    const [payloadB64, signatureB64] = parts;
    
    // Decode payload
    let payload;
    try {
      const payloadJson = Buffer.from(payloadB64, 'base64').toString('utf8');
      payload = JSON.parse(payloadJson);
    } catch (e) {
      return { valid: false, error: 'Corrupted payload' };
    }
    
    // Verify payload version
    if (payload.version !== GENERATOR_CONFIG.licenseVersion) {
      return { valid: false, error: 'Incompatible license version' };
    }
    
    // Verify machine ID
    if (payload.machineId !== machineId) {
      return { 
        valid: false, 
        error: 'License key does not match this machine',
        issuedFor: payload.machineId
      };
    }
    
    // Verify expiry date
    const expiry = new Date(payload.expiryDate);
    const now = new Date();
    if (now > expiry) {
      return { 
        valid: false, 
        error: 'License has expired', 
        expiryDate: payload.expiryDate,
        daysExpired: Math.floor((now - expiry) / (1000 * 60 * 60 * 24))
      };
    }
    
    // Verify signature
    const publicKey = loadPublicKey(publicKeyPath);
    const verify = crypto.createVerify(GENERATOR_CONFIG.algorithm);
    verify.update(JSON.stringify(payload));
    
    const signatureHex = Buffer.from(signatureB64, 'base64').toString('hex');
    const isValid = verify.verify(publicKey, signatureHex, 'hex');
    
    if (!isValid) {
      return { 
        valid: false, 
        error: 'License key signature verification failed (tampering detected)',
        severity: 'critical'
      };
    }
    
    // Calculate days remaining
    const daysRemaining = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
    
    return {
      valid: true,
      payload,
      licenseType: payload.licenseType,
      expiryDate: payload.expiryDate,
      daysRemaining,
      features: payload.features,
      maxClients: payload.maxClients,
      issuedAt: payload.issuedAt,
      verifiedAt: new Date().toISOString()
    };
  } catch (error) {
    return { 
      valid: false, 
      error: error.message,
      severity: 'error'
    };
  }
}

/**
 * Generate bulk licenses
 */
function generateBulkLicenses(machineIds, expiryDate, licenseType, privateKeyPath = './keys/private.pem') {
  return machineIds.map(machineId => {
    try {
      return generateLicense(machineId, expiryDate, licenseType, privateKeyPath);
    } catch (error) {
      return { machineId, error: error.message };
    }
  });
}

/**
 * Generate a test machine ID
 */
function generateTestMachineId() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

// ===== CLI INTERFACE =====

if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
╔═════════════════════════════════════════════════════════════════════╗
║          MIGL License Generator v2.0 (ECDSA Cryptographic)          ║
╚═════════════════════════════════════════════════════════════════════╝

USAGE:
  node license-generator-v2.js --generate-keys
  node license-generator-v2.js <machineId> <expiryDate> [licenseType]
  node license-generator-v2.js --validate <licenseKey> <machineId>
  node license-generator-v2.js --generate-machine-id
  node license-generator-v2.js --bulk <file.json>

EXAMPLES:
  Generate key pair (run once, save keys securely):
    node license-generator-v2.js --generate-keys

  Generate a license (requires private key):
    node license-generator-v2.js ABC123DEF456GHI 2025-12-31 professional

  Validate a license (requires public key):
    node license-generator-v2.js --validate MIG2-... ABC123DEF456GHI

  Generate a test machine ID:
    node license-generator-v2.js --generate-machine-id

  Generate bulk licenses from JSON:
    node license-generator-v2.js --bulk machines.json
    
    machines.json format:
    {
      "licenses": [
        {"machineId": "ABC123...", "expiryDate": "2025-12-31", "licenseType": "professional"},
        {"machineId": "XYZ789...", "expiryDate": "2025-12-31", "licenseType": "trial"}
      ]
    }

SECURITY NOTES:
  - Private key (./keys/private.pem) should be kept secure!
  - Public key (./keys/public.pem) is embedded in the app for validation
  - Each license is digitally signed with ECDSA P-256
  - Tampering detection is built-in (signature verification)
    `);
    process.exit(0);
  }
  
  switch (args[0]) {
    case '--generate-keys': {
      console.log('🔑 Generating ECDSA P-256 key pair...');
      const keys = generateKeyPair();
      
      const privateKeyPath = './keys/private.pem';
      const publicKeyPath = './keys/public.pem';
      
      savePrivateKey(keys.privateKey, privateKeyPath);
      savePublicKey(keys.publicKey, publicKeyPath);
      
      console.log(`\n✓ Key pair generated successfully!`);
      console.log(`  Curve: ${keys.curve}`);
      console.log(`  Generated: ${keys.generatedAt}`);
      console.log(`\n⚠️  IMPORTANT:`);
      console.log(`  - Keep private.pem secure (only in license generator)`);
      console.log(`  - Distribute public.pem to the app`);
      console.log(`  - Never commit private.pem to version control`);
      break;
    }
    
    case '--generate-machine-id': {
      const machineId = generateTestMachineId();
      console.log(`Generated Test Machine ID:\n\n  ${machineId}\n`);
      break;
    }
    
    case '--validate': {
      if (args.length < 3) {
        console.error('Usage: node license-generator-v2.js --validate <licenseKey> <machineId>');
        process.exit(1);
      }
      const result = validateLicense(args[1], args[2]);
      console.log('\nValidation Result:');
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    
    case '--bulk': {
      if (args.length < 2) {
        console.error('Usage: node license-generator-v2.js --bulk <file.json>');
        process.exit(1);
      }
      
      try {
        const fileContent = fs.readFileSync(args[1], 'utf8');
        const { licenses } = JSON.parse(fileContent);
        
        if (!Array.isArray(licenses)) {
          throw new Error('JSON must contain licenses array');
        }
        
        console.log(`\n📋 Generating ${licenses.length} licenses...\n`);
        const results = [];
        
        licenses.forEach((config, index) => {
          const result = generateLicense(
            config.machineId,
            config.expiryDate,
            config.licenseType || 'trial'
          );
          results.push(result);
          console.log(`[${index + 1}/${licenses.length}] Generated for ${config.machineId}`);
        });
        
        const outputFile = './bulk-licenses.json';
        fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
        console.log(`\n✓ Licenses saved to ${outputFile}`);
      } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
      }
      break;
    }
    
    default: {
      // Generate single license
      if (args.length < 2) {
        console.error('Usage: node license-generator-v2.js <machineId> <expiryDate> [licenseType]');
        process.exit(1);
      }
      
      try {
        const result = generateLicense(args[0], args[1], args[2] || 'trial');
        
        console.log('\n╔════════════════════════════════════════════════════╗');
        console.log('║              LICENSE GENERATED SUCCESSFULLY         ║');
        console.log('╚════════════════════════════════════════════════════╝\n');
        console.log(`License Key:\n  ${result.licenseKey}\n`);
        console.log('Details:');
        console.log(`  Machine ID:   ${result.payload.machineId}`);
        console.log(`  Type:         ${result.payload.licenseType}`);
        console.log(`  Expires:      ${result.payload.expiryDate}`);
        console.log(`  Features:     ${result.payload.features.join(', ')}`);
        console.log(`  Max Clients:  ${result.payload.maxClients === -1 ? 'Unlimited' : result.payload.maxClients}`);
        console.log(`  Issued:       ${result.payload.issuedAt}`);
        console.log('');
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    }
  }
}

// ===== EXPORTS =====
module.exports = {
  // Key management
  generateKeyPair,
  savePrivateKey,
  savePublicKey,
  loadPrivateKey,
  loadPublicKey,
  
  // License generation/validation
  generateLicense,
  validateLicense,
  generateBulkLicenses,
  generateTestMachineId,
  
  // Utility functions
  isLicenseExpiringSoon,
  getLicenseStatusMessage,
  formatLicenseForDisplay,
  calculateLicenseValue,
  
  // Constants
  LICENSE_TYPES,
  GENERATOR_CONFIG
};

// ===== ADDITIONAL UTILITY FUNCTIONS =====

/**
 * Check if license is expiring within specified days
 * @param {object} validationResult - Result from validateLicense()
 * @param {number} warningDays - Days threshold (default: 30)
 * @returns {boolean}
 */
function isLicenseExpiringSoon(validationResult, warningDays = 30) {
  if (!validationResult || !validationResult.valid) return false;
  return validationResult.daysRemaining <= warningDays;
}

/**
 * Get human-readable license status message
 * @param {object} validationResult - Result from validateLicense()
 * @returns {string}
 */
function getLicenseStatusMessage(validationResult) {
  if (!validationResult) return '❌ No license data';
  
  if (!validationResult.valid) {
    if (validationResult.severity === 'critical') {
      return `🚨 ${validationResult.error}`;
    }
    return `❌ ${validationResult.error}`;
  }
  
  if (validationResult.daysRemaining <= 7) {
    return `⚠️ License expires in ${validationResult.daysRemaining} day(s)! Renew now.`;
  }
  
  if (validationResult.daysRemaining <= 30) {
    return `ℹ️ License expires in ${validationResult.daysRemaining} days. Consider renewal.`;
  }
  
  return `✅ License valid (${validationResult.daysRemaining} days remaining)`;
}

/**
 * Format license details for display
 * @param {object} licenseData - License payload or validation result
 * @returns {string} Formatted string
 */
function formatLicenseForDisplay(licenseData) {
  if (!licenseData) return 'No license data';
  
  const data = licenseData.payload || licenseData;
  const lines = [
    `License Type:  ${(data.licenseType || 'Unknown').toUpperCase()}`,
    `Expiry Date:   ${data.expiryDate || 'N/A'}`,
    `Machine ID:    ${data.machineId ? data.machineId.substring(0, 12) + '...' : 'N/A'}`,
    `Max Clients:   ${data.maxClients === -1 ? 'Unlimited' : (data.maxClients || 'N/A')}`,
    `Features:      ${(data.features || []).join(', ') || 'None'}`
  ];
  
  if (licenseData.daysRemaining !== undefined) {
    lines.push(`Days Left:     ${licenseData.daysRemaining}`);
  }
  
  return lines.join('\n');
}

/**
 * Calculate estimated license value
 * @param {string} licenseType - License type
 * @param {number} daysRemaining - Days until expiry
 * @returns {object} Value calculation
 */
function calculateLicenseValue(licenseType, daysRemaining) {
  const typeInfo = LICENSE_TYPES[licenseType];
  if (!typeInfo) return { value: 0, error: 'Unknown license type' };
  
  const annualPrice = typeInfo.price;
  const dailyValue = annualPrice / 365;
  const remainingValue = Math.max(0, dailyValue * daysRemaining);
  
  return {
    annualPrice,
    dailyValue: dailyValue.toFixed(2),
    remainingValue: remainingValue.toFixed(2),
    daysRemaining,
    percentRemaining: Math.round((daysRemaining / 365) * 100)
  };
}
