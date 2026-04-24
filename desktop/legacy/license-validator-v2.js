/**
 * MIGL License Validator - App-Side License Validation
 * Uses ECDSA signature verification to validate licenses
 * 
 * The public key is embedded in the app
 * This checks:
 * 1. License format and structure
 * 2. Machine ID match
 * 3. Expiry date
 * 4. Digital signature (ECDSA P-256)
 * 5. Tampering detection
 */

const crypto = require('crypto');

/**
 * Public key embedded in app (from license generator)
 * This is the actual ECDSA P-256 public key from ./keys/public.pem
 */
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEp1k8w1qVmClDpWDi9NUo5thkMp/g
XYfcwD13luKLWs0VyfZyFcplIUWqRra3f8gPF2Zr+nO/Jcfmy1hmGBbPBg==
-----END PUBLIC KEY-----`;

// License types reference (mirrors generator)
const LICENSE_TYPES = {
  trial: {
    maxClients: 10,
    features: ['basic']
  },
  personal: {
    maxClients: 50,
    features: ['basic', 'reports']
  },
  professional: {
    maxClients: 500,
    features: ['basic', 'reports', 'advanced', 'multi-user']
  },
  enterprise: {
    maxClients: -1,
    features: ['basic', 'reports', 'advanced', 'multi-user', 'api', 'priority-support']
  }
};

const GENERATOR_CONFIG = {
  algorithm: 'sha256',
  licenseVersion: 2
};

/**
 * Validate a signed license key
 * @param {string} licenseKey - License key to validate (format: MIG2-payload.signature)
 * @param {string} machineId - Machine ID from the app
 * @param {string} publicKeyPem - PEM-encoded public key (optional, uses embedded by default)
 * @returns {object} Validation result
 */
function validateLicense(licenseKey, machineId, publicKeyPem = PUBLIC_KEY_PEM) {
  try {
    // Validate input
    if (!licenseKey || typeof licenseKey !== 'string') {
      return {
        valid: false,
        error: 'License key must be a non-empty string',
        severity: 'error'
      };
    }

    if (!machineId || typeof machineId !== 'string') {
      return {
        valid: false,
        error: 'Machine ID must be a non-empty string',
        severity: 'error'
      };
    }

    // Step 1: Parse license key
    if (!licenseKey.startsWith('MIG2-')) {
      return {
        valid: false,
        error: 'Invalid license key format (expected MIG2- prefix)',
        version: 1,
        severity: 'error'
      };
    }

    const keyContent = licenseKey.substring(5); // Remove 'MIG2-' prefix
    const parts = keyContent.split('.');

    if (parts.length !== 2) {
      return {
        valid: false,
        error: 'Invalid license key structure (expected: MIG2-payload.signature)',
        severity: 'error'
      };
    }

    const [payloadB64, signatureB64] = parts;

    // Step 2: Decode payload
    let payload;
    try {
      const payloadJson = Buffer.from(payloadB64, 'base64').toString('utf8');
      payload = JSON.parse(payloadJson);
    } catch (e) {
      return {
        valid: false,
        error: 'Corrupted or invalid payload encoding',
        severity: 'error'
      };
    }

    // Step 3: Verify payload structure
    if (!payload || typeof payload !== 'object') {
      return {
        valid: false,
        error: 'Invalid payload structure',
        severity: 'error'
      };
    }

    if (!payload.version || !payload.machineId || !payload.expiryDate || !payload.licenseType) {
      return {
        valid: false,
        error: 'Missing required payload fields (version, machineId, expiryDate, licenseType)',
        severity: 'error'
      };
    }

    // Step 4: Verify license version
    if (payload.version !== GENERATOR_CONFIG.licenseVersion) {
      return {
        valid: false,
        error: `Incompatible license version (expected ${GENERATOR_CONFIG.licenseVersion}, got ${payload.version})`,
        severity: 'error'
      };
    }

    // Step 5: Verify machine ID matches
    if (payload.machineId !== machineId) {
      return {
        valid: false,
        error: 'License key does not match this machine',
        issuedFor: payload.machineId,
        severity: 'critical'
      };
    }

    // Step 6: Verify license type is valid
    if (!LICENSE_TYPES[payload.licenseType]) {
      return {
        valid: false,
        error: `Invalid license type: ${payload.licenseType}`,
        severity: 'error'
      };
    }

    // Step 7: Verify expiry date format and validate
    let expiryDate;
    try {
      expiryDate = new Date(payload.expiryDate);
      if (isNaN(expiryDate.getTime())) {
        throw new Error('Invalid date format');
      }
    } catch (e) {
      return {
        valid: false,
        error: 'Invalid expiry date format in license',
        severity: 'error'
      };
    }

    const now = new Date();
    if (now > expiryDate) {
      const daysExpired = Math.floor((now - expiryDate) / (1000 * 60 * 60 * 24));
      return {
        valid: false,
        error: 'License has expired',
        expiryDate: payload.expiryDate,
        daysExpired,
        severity: 'critical'
      };
    }

    // Step 8: Verify digital signature (CRITICAL SECURITY CHECK)
    try {
      const verify = crypto.createVerify(GENERATOR_CONFIG.algorithm);
      verify.update(JSON.stringify(payload)); // Must use exact same format as generator

      const signatureHex = Buffer.from(signatureB64, 'base64').toString('hex');
      const isSignatureValid = verify.verify(publicKeyPem, signatureHex, 'hex');

      if (!isSignatureValid) {
        return {
          valid: false,
          error: 'License signature verification failed - LICENSE MAY BE TAMPERED',
          severity: 'critical',
          tampering: true
        };
      }
    } catch (signError) {
      return {
        valid: false,
        error: `Signature verification error: ${signError.message}`,
        severity: 'error',
        tampering: true
      };
    }

    // Step 9: All checks passed - calculate remaining validity
    const daysRemaining = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
    const issuedAt = payload.issuedAt ? new Date(payload.issuedAt) : null;

    return {
      valid: true,
      payload,
      licenseType: payload.licenseType,
      expiryDate: payload.expiryDate,
      daysRemaining,
      features: payload.features || LICENSE_TYPES[payload.licenseType].features,
      maxClients: payload.maxClients || LICENSE_TYPES[payload.licenseType].maxClients,
      issuedAt: payload.issuedAt,
      verifiedAt: new Date().toISOString(),
      signature: 'VALID'
    };
  } catch (error) {
    return {
      valid: false,
      error: `Unexpected validation error: ${error.message}`,
      severity: 'error'
    };
  }
}

/**
 * Check if a license is about to expire (within X days)
 * @param {object} validationResult - Result from validateLicense()
 * @param {number} warningDays - Days before expiry to warn (default: 30)
 * @returns {boolean} True if license expires within warning period
 */
function isLicenseExpiringSoon(validationResult, warningDays = 30) {
  if (!validationResult.valid) return false;
  return validationResult.daysRemaining <= warningDays;
}

/**
 * Check if user has a specific feature in their license
 * @param {object} validationResult - Result from validateLicense()
 * @param {string} feature - Feature name to check
 * @returns {boolean} True if user has this feature
 */
function hasFeature(validationResult, feature) {
  if (!validationResult.valid || !validationResult.features) return false;
  return validationResult.features.includes(feature);
}

/**
 * Get human-readable license status message
 * @param {object} validationResult - Result from validateLicense()
 * @returns {string} Status message
 */
function getLicenseStatusMessage(validationResult) {
  if (!validationResult.valid) {
    if (validationResult.severity === 'critical' && validationResult.tampering) {
      return `⚠️ Security Alert: ${validationResult.error}`;
    }
    return `❌ ${validationResult.error}`;
  }

  if (validationResult.daysRemaining <= 7) {
    return `⚠️ License expires in ${validationResult.daysRemaining} day(s)`;
  }

  if (validationResult.daysRemaining <= 30) {
    return `ℹ️ License expires in ${validationResult.daysRemaining} days`;
  }

  return `✓ License valid (${validationResult.daysRemaining} days remaining)`;
}

/**
 * Validate license at app startup
 * @param {string} licenseKey - Stored license key
 * @param {string} machineId - App machine ID
 * @returns {object} License validation result
 */
function validateLicenseAtStartup(licenseKey, machineId) {
  if (!licenseKey) {
    return {
      valid: false,
      error: 'No license found',
      severity: 'warning'
    };
  }

  const result = validateLicense(licenseKey, machineId);

  // Log tampering attempts
  if (result.tampering) {
    console.error('🚨 License tampering detected!', {
      timestamp: new Date().toISOString(),
      machineId,
      error: result.error
    });
  }

  return result;
}

// ===== EXPORTS =====
module.exports = {
  validateLicense,
  validateLicenseAtStartup,
  isLicenseExpiringSoon,
  hasFeature,
  getLicenseStatusMessage,
  LICENSE_TYPES,
  GENERATOR_CONFIG
};
