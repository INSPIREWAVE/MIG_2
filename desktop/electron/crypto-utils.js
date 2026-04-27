/**
 * MIGL Crypto Utilities
 * Handles encryption/decryption of sensitive data
 */

const crypto = require('crypto');

const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
const AUTH_TAG_LENGTH = 16;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;

/**
 * Derive encryption key from password using PBKDF2
 */
function deriveKeyFromPassword(password, salt = null) {
  const actualSalt = salt || crypto.randomBytes(SALT_LENGTH);
  const key = crypto.pbkdf2Sync(password, actualSalt, 100000, 32, 'sha256');
  return { key, salt: actualSalt };
}

/**
 * Encrypt data with AES-256-CBC
 * Returns: { encrypted, iv, salt, authTag } as base64
 */
function encryptData(data, password) {
  try {
    const { key, salt } = deriveKeyFromPassword(password);
    const iv = crypto.randomBytes(IV_LENGTH);
    
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return {
      encrypted: Buffer.from(encrypted, 'hex').toString('base64'),
      iv: iv.toString('base64'),
      salt: salt.toString('base64'),
      algorithm: ENCRYPTION_ALGORITHM
    };
  } catch (err) {
    throw new Error(`Encryption failed: ${err.message}`);
  }
}

/**
 * Decrypt data with AES-256-CBC
 */
function decryptData(encryptedObj, password) {
  try {
    if (!encryptedObj.salt || !encryptedObj.iv || !encryptedObj.encrypted) {
      throw new Error('Missing encryption components');
    }
    
    const salt = Buffer.from(encryptedObj.salt, 'base64');
    const iv = Buffer.from(encryptedObj.iv, 'base64');
    const encrypted = Buffer.from(encryptedObj.encrypted, 'base64');
    
    const { key } = deriveKeyFromPassword(password, salt);
    
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted.toString('utf8');
  } catch (err) {
    throw new Error(`Decryption failed: ${err.message}`);
  }
}

/**
 * Hash a value for comparison (one-way)
 */
function hashValue(value, salt = null) {
  const actualSalt = salt || crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(value, actualSalt, 10000, 32, 'sha256');
  return {
    hash: hash.toString('hex'),
    salt: actualSalt.toString('hex')
  };
}

/**
 * Verify a hashed value
 */
function verifyHash(value, hash, salt) {
  try {
    const saltBuffer = Buffer.from(salt, 'hex');
    const computed = crypto.pbkdf2Sync(value, saltBuffer, 10000, 32, 'sha256');
    return computed.toString('hex') === hash;
  } catch (err) {
    return false;
  }
}

module.exports = {
  encryptData,
  decryptData,
  hashValue,
  verifyHash,
  deriveKeyFromPassword
};
