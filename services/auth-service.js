/**
 * MIGL v3.0.0 - Authentication Service
 * Handles user authentication, JWT tokens, and password management
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db-v3');
const logger = require('./logger');
const { authError, conflictError, validationError, asyncHandler } = require('./error-handler');
const { validateEmail, validatePassword } = require('./validation');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret';
const JWT_EXPIRY = '24h';
const REFRESH_EXPIRY = '7d';

/**
 * Hash password
 */
async function hashPassword(password) {
  return await bcrypt.hash(password, 10);
}

/**
 * Compare password
 */
async function comparePassword(plainPassword, hashedPassword) {
  return await bcrypt.compare(plainPassword, hashedPassword);
}

/**
 * Generate JWT token
 */
function generateToken(user, secret = JWT_SECRET, expiresIn = JWT_EXPIRY) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      email: user.email,
      branch_id: user.branch_id,
      role: user.role,
    },
    secret,
    { expiresIn }
  );
}

/**
 * Verify JWT token
 */
function verifyToken(token, secret = JWT_SECRET) {
  try {
    return jwt.verify(token, secret);
  } catch (error) {
    return null;
  }
}

/**
 * Decode token without verification (for refresh)
 */
function decodeToken(token) {
  return jwt.decode(token);
}

/**
 * Register new user
 */
async function register(email, username, password, branch_id, role = 'officer') {
  try {
    // Validate email
    const emailVal = validateEmail(email);
    if (!emailVal.valid) throw validationError(emailVal.error, 'email');
    
    // Validate password
    const passVal = validatePassword(password);
    if (!passVal.valid) throw validationError(passVal.error, 'password');
    
    // Check if user exists
    const existing = await db.query(
      'SELECT id FROM users WHERE email = $1 OR username = $2 LIMIT 1',
      [emailVal.value, username]
    );
    
    if (existing.rows.length > 0) {
      throw conflictError('User already exists with this email or username');
    }
    
    // Hash password
    const hashedPassword = await hashPassword(password);
    
    // Create user
    const result = await db.query(
      `INSERT INTO users (email, username, password_hash, branch_id, role, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, true, NOW())
       RETURNING id, email, username, role, branch_id`,
      [emailVal.value, username, hashedPassword, branch_id, role]
    );
    
    const user = result.rows[0];
    
    // Log audit
    await db.query(
      `INSERT INTO audit_logs (branch_id, user_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, 'USER_CREATED', 'user', $3, $4)`,
      [branch_id, user.id, user.id, JSON.stringify({ email: user.email })]
    );
    
    logger.info('User registered', { userID: user.id, email: user.email });
    
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      branch_id: user.branch_id,
    };
  } catch (error) {
    logger.error('Registration failed', { email, error: error.message });
    throw error;
  }
}

/**
 * Login user
 */
async function login(email, password) {
  try {
    // Validate email
    const emailVal = validateEmail(email);
    if (!emailVal.valid) throw authError('Invalid credentials');
    
    // Find user
    const result = await db.query(
      `SELECT id, email, username, password_hash, role, branch_id, is_active
       FROM users WHERE email = $1 LIMIT 1`,
      [emailVal.value]
    );
    
    if (result.rows.length === 0) {
      logger.warn('Login attempt for non-existent user', { email: emailVal.value });
      throw authError('Invalid credentials');
    }
    
    const user = result.rows[0];
    
    // Check if active
    if (!user.is_active) {
      throw authError('User account is inactive');
    }
    
    // Compare password
    const validPassword = await comparePassword(password, user.password_hash);
    if (!validPassword) {
      logger.warn('Failed login attempt', { userID: user.id, email: user.email });
      throw authError('Invalid credentials');
    }
    
    // Update last login
    await db.query(
      'UPDATE users SET last_login = NOW() WHERE id = $1',
      [user.id]
    );
    
    // Generate tokens
    const accessToken = generateToken(user);
    const refreshToken = generateToken(user, JWT_REFRESH_SECRET, REFRESH_EXPIRY);
    
    // Log audit
    await db.query(
      `INSERT INTO audit_logs (branch_id, user_id, action, entity_type)
       VALUES ($1, $2, 'LOGIN', 'user')`,
      [user.branch_id, user.id]
    );
    
    logger.info('User logged in', { userID: user.id, email: user.email });
    
    return {
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        branch_id: user.branch_id,
      },
      accessToken,
      refreshToken,
    };
  } catch (error) {
    logger.error('Login failed', { error: error.message });
    throw error;
  }
}

/**
 * Refresh access token
 */
async function refreshAccessToken(refreshToken) {
  try {
    const decoded = verifyToken(refreshToken, JWT_REFRESH_SECRET);
    if (!decoded) {
      throw authError('Invalid or expired refresh token');
    }
    
    // Get user
    const result = await db.query(
      'SELECT id, email, username, role, branch_id FROM users WHERE id = $1 AND is_active = true',
      [decoded.id]
    );
    
    if (result.rows.length === 0) {
      throw authError('User not found or inactive');
    }
    
    const user = result.rows[0];
    const newAccessToken = generateToken(user);
    
    return { accessToken: newAccessToken };
  } catch (error) {
    logger.error('Token refresh failed', { error: error.message });
    throw error;
  }
}

/**
 * Request password reset
 */
async function requestPasswordReset(email) {
  try {
    const emailVal = validateEmail(email);
    if (!emailVal.valid) {
      // Don't leak if email exists
      return { message: 'If email exists, password reset link sent' };
    }
    
    const result = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [emailVal.value]
    );
    
    if (result.rows.length === 0) {
      // Don't leak if email exists
      return { message: 'If email exists, password reset link sent' };
    }
    
    const userId = result.rows[0].id;
    
    // Generate reset token (2 hour expiry)
    const resetToken = generateToken({ id: userId }, JWT_SECRET, '2h');
    
    // In production, send email with reset link
    logger.info('Password reset requested', { userID: userId });
    
    return { message: 'If email exists, password reset link sent' };
  } catch (error) {
    logger.error('Password reset request failed', { error: error.message });
    throw error;
  }
}

/**
 * Reset password
 */
async function resetPassword(token, newPassword) {
  try {
    const passVal = validatePassword(newPassword);
    if (!passVal.valid) throw validationError(passVal.error, 'password');
    
    const decoded = verifyToken(token, JWT_SECRET);
    if (!decoded) {
      throw authError('Invalid or expired reset token');
    }
    
    // Hash new password
    const hashedPassword = await hashPassword(newPassword);
    
    // Update user
    const result = await db.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW()
       WHERE id = $2 AND is_active = true
       RETURNING id, email`,
      [hashedPassword, decoded.id]
    );
    
    if (result.rows.length === 0) {
      throw authError('User not found or inactive');
    }
    
    const user = result.rows[0];
    
    // Log audit
    await db.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id)
       VALUES ($1, 'PASSWORD_RESET', 'user', $2)`,
      [user.id, user.id]
    );
    
    logger.info('Password reset successfully', { userID: user.id });
    
    return { message: 'Password reset successfully' };
  } catch (error) {
    logger.error('Password reset failed', { error: error.message });
    throw error;
  }
}

/**
 * Get user by ID
 */
async function getUserById(userId) {
  const result = await db.query(
    `SELECT id, email, username, role, branch_id, is_active, last_login, created_at
     FROM users WHERE id = $1`,
    [userId]
  );
  
  if (result.rows.length === 0) {
    return null;
  }
  
  return result.rows[0];
}

/**
 * List users
 */
async function listUsers(branchId, limit = 50, offset = 0) {
  const result = await db.query(
    `SELECT id, email, username, role, branch_id, is_active, last_login, created_at
     FROM users WHERE branch_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [branchId, limit, offset]
  );
  
  return result.rows;
}

module.exports = {
  hashPassword,
  comparePassword,
  generateToken,
  verifyToken,
  decodeToken,
  register,
  login,
  refreshAccessToken,
  requestPasswordReset,
  resetPassword,
  getUserById,
  listUsers,
};
