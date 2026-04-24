// ========================================
// v3 Users & RBAC API Routes
// User management and permission control
// ========================================

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db-v3');

const router = express.Router();

// ========================================
// Get all users (HO/Branch Manager view with scoping)
// ========================================
router.get('/', async (req, res) => {
  try {
    const userRole = req.user?.role;
    const userBranchId = req.user?.branchId;

    let query = `
      SELECT u.id, u.username, u.email, u.full_name, u.branch_id, 
             u.is_active, u.created_at, r.name as role
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      WHERE u.username IS NOT NULL
    `;

    // Branch managers see only users in their branch
    if (userRole !== 'Super Admin' && userRole !== 'HO Manager') {
      query += ` AND u.branch_id = $1`;
      const result = await pool.query(query, [userBranchId]);
      return res.json({ success: true, users: result.rows });
    }

    const result = await pool.query(query);
    res.json({ success: true, users: result.rows });
  } catch (error) {
    console.error('Fetch users error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// Get roles
// ========================================
router.get('/config/roles', async (req, res) => {
  try {
    const query = 'SELECT id, name, description FROM roles ORDER BY tier_level DESC';
    const result = await pool.query(query);
    res.json({ success: true, roles: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// Get user by ID
// ========================================
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role;
    const userBranchId = req.user?.branchId;

    const query = `
      SELECT u.id, u.username, u.email, u.full_name, u.branch_id, 
             u.is_active, u.mfa_enabled, u.last_login, u.created_at, r.name as role
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      WHERE u.id = $1
    `;

    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Check access: HO can view all, branch managers see own branch users
    if (userRole !== 'Super Admin' && userRole !== 'HO Manager' && user.branch_id !== userBranchId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// Create user (HO/Branch Manager)
// ========================================
router.post('/', async (req, res) => {
  try {
    const userRole = req.user?.role;
    const userBranchId = req.user?.branchId;
    const { username, email, password, full_name, branch_id, role_name } = req.body;

    if (!username || !email || !password || !full_name || !branch_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check permissions: only HO can assign to other branches
    if (userRole !== 'Super Admin' && userRole !== 'HO Manager' && branch_id !== userBranchId) {
      return res.status(403).json({ error: 'Unauthorized to assign to other branches' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const roleQuery = 'SELECT id FROM roles WHERE name = $1';
    const roleResult = await pool.query(roleQuery, [role_name || 'Loan Officer']);
    const roleId = roleResult.rows[0]?.id;

    const query = `
      INSERT INTO users (username, email, password_hash, full_name, branch_id, role_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, username, email, full_name, branch_id
    `;

    const result = await pool.query(query, [username, email, passwordHash, full_name, branch_id, roleId]);

    res.status(201).json({
      success: true,
      user: result.rows[0],
      message: 'User created successfully'
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    console.error('Create user error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// Update user role and permissions
// ========================================
router.put('/:id/role', async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role;
    const { role_name } = req.body;

    // Only HO can change roles
    if (userRole !== 'Super Admin' && userRole !== 'HO Manager') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const roleQuery = 'SELECT id FROM roles WHERE name = $1';
    const roleResult = await pool.query(roleQuery, [role_name]);

    if (roleResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid role name' });
    }

    const updateQuery = 'UPDATE users SET role_id = $1 WHERE id = $2 RETURNING *';
    const result = await pool.query(updateQuery, [roleResult.rows[0].id, id]);

    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// Toggle user status (active/inactive)
// ========================================
router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role;
    const { is_active } = req.body;

    if (userRole !== 'Super Admin' && userRole !== 'HO Manager') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const query = 'UPDATE users SET is_active = $1 WHERE id = $2 RETURNING *';
    const result = await pool.query(query, [is_active, id]);

    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// Get permissions for a role
// ========================================
router.get('/:roleId/permissions', async (req, res) => {
  try {
    const { roleId } = req.params;

    const query = `
      SELECT p.id, p.name, p.resource, p.action, p.description
      FROM permissions p
      JOIN role_permissions rp ON p.id = rp.permission_id
      WHERE rp.role_id = $1
      ORDER BY p.resource, p.action
    `;

    const result = await pool.query(query, [roleId]);
    res.json({ success: true, permissions: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
