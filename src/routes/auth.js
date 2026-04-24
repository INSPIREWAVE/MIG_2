// ========================================
// v3 Auth Service & Routes
// JWT + RBAC + MFA support
// ========================================

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const JWT_EXPIRES_IN = '24h';
const REFRESH_EXPIRES_IN = '7d';

// ========================================
// Register
// ========================================
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, full_name, branch_id } = req.body;

    // Validate input
    if (!username || !email || !password || !full_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Hash password with bcrypt
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert user
    const query = `
      INSERT INTO users (username, email, password_hash, full_name, branch_id, role_id)
      VALUES ($1, $2, $3, $4, $5, (SELECT id FROM roles WHERE name = 'Loan Officer' LIMIT 1))
      RETURNING id, username, email, full_name, branch_id
    `;

    const result = await pool.query(query, [username, email, passwordHash, full_name, branch_id]);

    if (result.rows.length === 0) {
      return res.status(500).json({ error: 'Failed to create user' });
    }

    res.status(201).json({
      success: true,
      user: result.rows[0],
      message: 'User registered successfully'
    });
  } catch (error) {
    console.error('Register error:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// Login
// ========================================
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Fetch user with role & permissions
    const userQuery = `
      SELECT u.id, u.username, u.email, u.password_hash, u.full_name, 
             u.branch_id, u.is_active, r.name as role_name
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      WHERE u.username = $1 OR u.email = $1
    `;

    const userResult = await pool.query(userQuery, [username]);

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is inactive' });
    }

    // Verify password
    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Fetch permissions
    const permQuery = `
      SELECT p.name FROM permissions p
      JOIN role_permissions rp ON p.id = rp.permission_id
      WHERE rp.role_id = (SELECT id FROM roles WHERE name = $1)
    `;

    const permResult = await pool.query(permQuery, [user.role_name]);
    const permissions = permResult.rows.map(r => r.name);

    // Generate tokens
    const accessToken = jwt.sign(
      {
        userId: user.id,
        username: user.username,
        branchId: user.branch_id,
        role: user.role_name,
        permissions
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const refreshToken = jwt.sign(
      { userId: user.id },
      JWT_SECRET,
      { expiresIn: REFRESH_EXPIRES_IN }
    );

    // Store session
    const sessionQuery = `
      INSERT INTO user_sessions (user_id, access_token_hash, refresh_token_hash, ip_address, user_agent, expires_at)
      VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '24 hours')
    `;

    const tokenHash = require('crypto').createHash('sha256').update(accessToken).digest('hex');
    const refreshHash = require('crypto').createHash('sha256').update(refreshToken).digest('hex');
    await pool.query(sessionQuery, [user.id, tokenHash, refreshHash, req.ip, req.get('user-agent')]);

    // Update last login
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    res.json({
      success: true,
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        branch_id: user.branch_id,
        role: user.role_name,
        permissions
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// Refresh Token
// ========================================
router.post('/refresh', (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    jwt.verify(refreshToken, JWT_SECRET, (err, decoded) => {
      if (err) {
        return res.status(403).json({ error: 'Invalid refresh token' });
      }

      const newAccessToken = jwt.sign(
        {
          userId: decoded.userId,
          // Add more payload as needed from DB query
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );

      res.json({
        success: true,
        accessToken: newAccessToken
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// Change Password
// ========================================
router.post('/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user?.userId;

    if (!userId || !currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Fetch current password hash
    const userQuery = 'SELECT password_hash FROM users WHERE id = $1';
    const userResult = await pool.query(userQuery, [userId]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const isValid = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const newHash = await bcrypt.hash(newPassword, 10);

    // Update password
    await pool.query('UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2', [newHash, userId]);

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// Logout
// ========================================
router.post('/logout', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (userId) {
      await pool.query('UPDATE user_sessions SET is_active = false WHERE user_id = $1', [userId]);
    }
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
