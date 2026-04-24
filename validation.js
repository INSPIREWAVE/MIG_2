/**
 * MIGL v3.0.0 - Validation Middleware
 * Input validation and sanitization for all API endpoints
 */

const logger = require('./logger');
const { validationError } = require('./error-handler');

/**
 * Email validation regex (RFC 5322 simplified)
 */
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * Phone validation regex - Zambia format support
 * Supports: +260XXXXXXXXX, 0XXXXXXXXX, 260XXXXXXXXX
 */
const PHONE_REGEX = /^(?:\+?260|0)?[97][0-9]{8}$/;

/**
 * Zambia NRC validation regex
 * Format: XXXXXX/XX/X (6 digits, 2 digits, 1 digit)
 */
const NRC_REGEX = /^\d{6}\/\d{2}\/\d{1}$/;

/**
 * URL validation regex
 */
const URL_REGEX = /^https?:\/\/.+/i;

/**
 * Validate email
 */
function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    return { valid: false, error: 'Email is required and must be string' };
  }
  
  const trimmed = email.trim().toLowerCase();
  
  if (!EMAIL_REGEX.test(trimmed)) {
    return { valid: false, error: 'Invalid email format' };
  }
  
  if (trimmed.length > 255) {
    return { valid: false, error: 'Email too long' };
  }
  
  // Ensure there's at least one character before @ and a valid domain
  const parts = trimmed.split('@');
  if (parts.length !== 2 || parts[0].length < 1 || parts[1].length < 3) {
    return { valid: false, error: 'Invalid email format' };
  }
  
  return { valid: true, value: trimmed };
}

/**
 * Validate password strength
 */
function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'Password is required' };
  }
  
  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }
  
  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: 'Password must contain uppercase letter' };
  }
  
  if (!/[a-z]/.test(password)) {
    return { valid: false, error: 'Password must contain lowercase letter' };
  }
  
  if (!/[0-9]/.test(password)) {
    return { valid: false, error: 'Password must contain digit' };
  }
  
  // SECURITY: Expanded special character set
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) {
    return { valid: false, error: 'Password must contain special character (!@#$%^&*()_+-=[]{}|,.<>/?~)' };
  }
  
  return { valid: true };
}

/**
 * Validate phone number (Zambia-optimized)
 */
function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') {
    return { valid: false, error: 'Phone is required' };
  }
  
  // Remove spaces, dashes, and parentheses for validation
  const cleaned = phone.trim().replace(/[\s\-()]/g, '');
  
  if (!PHONE_REGEX.test(cleaned)) {
    return { valid: false, error: 'Invalid Zambia phone format. Use +260XXXXXXXXX or 0XXXXXXXXX' };
  }
  
  // Normalize to +260 format
  let normalized = cleaned;
  if (cleaned.startsWith('0')) {
    normalized = '+260' + cleaned.substring(1);
  } else if (cleaned.startsWith('260')) {
    normalized = '+' + cleaned;
  } else if (!cleaned.startsWith('+')) {
    normalized = '+260' + cleaned;
  }
  
  return { valid: true, value: normalized };
}

/**
 * Validate Zambia NRC (National Registration Card)
 */
function validateNRC(nrc) {
  if (!nrc || typeof nrc !== 'string') {
    return { valid: false, error: 'NRC is required' };
  }
  
  const trimmed = nrc.trim().toUpperCase();
  
  if (!NRC_REGEX.test(trimmed)) {
    return { valid: false, error: 'Invalid NRC format. Use XXXXXX/XX/X' };
  }
  
  return { valid: true, value: trimmed };
}

/**
 * Validate numeric amount
 */
function validateAmount(amount, minAmount = 0, maxAmount = 999999999) {
  if (amount === null || amount === undefined) {
    return { valid: false, error: 'Amount is required' };
  }
  
  const num = parseFloat(amount);
  
  if (isNaN(num)) {
    return { valid: false, error: 'Amount must be numeric' };
  }
  
  if (num < minAmount) {
    return { valid: false, error: `Amount must be at least ${minAmount}` };
  }
  
  if (num > maxAmount) {
    return { valid: false, error: `Amount cannot exceed ${maxAmount}` };
  }
  
  // Check decimal places (max 2 for currency)
  if (!/^\d+(\.\d{1,2})?$/.test(amount.toString())) {
    return { valid: false, error: 'Amount can have maximum 2 decimal places' };
  }
  
  return { valid: true, value: num };
}

/**
 * Validate date
 */
function validateDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') {
    return { valid: false, error: 'Date is required' };
  }
  
  const date = new Date(dateStr);
  
  if (isNaN(date.getTime())) {
    return { valid: false, error: 'Invalid date format (use YYYY-MM-DD)' };
  }
  
  return { valid: true, value: date.toISOString().split('T')[0] };
}

/**
 * Validate UUID
 */
function validateUUID(id) {
  if (!id || typeof id !== 'string') {
    return { valid: false, error: 'ID is required' };
  }
  
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  
  if (!uuidRegex.test(id)) {
    return { valid: false, error: 'Invalid UUID format' };
  }
  
  return { valid: true, value: id };
}

/**
 * Validate integer
 */
function validateInteger(value, min = null, max = null) {
  if (value === null || value === undefined) {
    return { valid: false, error: 'Value is required' };
  }
  
  const num = parseInt(value);
  
  if (isNaN(num)) {
    return { valid: false, error: 'Value must be integer' };
  }
  
  if (min !== null && num < min) {
    return { valid: false, error: `Value must be at least ${min}` };
  }
  
  if (max !== null && num > max) {
    return { valid: false, error: `Value cannot exceed ${max}` };
  }
  
  return { valid: true, value: num };
}

/**
 * Validate string
 */
function validateString(value, minLen = 1, maxLen = 255) {
  if (!value || typeof value !== 'string') {
    return { valid: false, error: 'Value is required and must be string' };
  }
  
  const trimmed = value.trim();
  
  if (trimmed.length < minLen) {
    return { valid: false, error: `Value must be at least ${minLen} characters` };
  }
  
  if (trimmed.length > maxLen) {
    return { valid: false, error: `Value cannot exceed ${maxLen} characters` };
  }
  
  return { valid: true, value: trimmed };
}

/**
 * Validate enum
 */
function validateEnum(value, allowedValues) {
  if (!value) {
    return { valid: false, error: 'Value is required' };
  }
  
  if (!allowedValues.includes(value)) {
    return { valid: false, error: `Value must be one of: ${allowedValues.join(', ')}` };
  }
  
  return { valid: true, value };
}

/**
 * Middleware: Validate request body
 */
function validateBody(schema) {
  return (req, res, next) => {
    const errors = {};
    
    for (const [field, validator] of Object.entries(schema)) {
      const value = req.body[field];
      const result = validator(value);
      
      if (!result.valid) {
        errors[field] = result.error;
      } else if (result.value !== undefined) {
        req.body[field] = result.value;
      }
    }
    
    if (Object.keys(errors).length > 0) {
      logger.warn('Validation error', { path: req.path, errors });
      return res.status(400).json({
        error: {
          code: 400,
          message: 'Validation failed',
          errors,
          timestamp: new Date().toISOString(),
        },
      });
    }
    
    next();
  };
}

/**
 * Sanitize object
 */
function sanitizeObject(obj, allowedFields) {
  const sanitized = {};
  
  for (const field of allowedFields) {
    if (obj.hasOwnProperty(field)) {
      sanitized[field] = obj[field];
    }
  }
  
  return sanitized;
}

module.exports = {
  validateEmail,
  validatePassword,
  validatePhone,
  validateNRC,
  validateAmount,
  validateDate,
  validateUUID,
  validateInteger,
  validateString,
  validateEnum,
  validateBody,
  sanitizeObject,
};
