// ========================================
// v3 Branches API Routes
// Multi-branch management with scoping
// ========================================

const express = require('express');
const { pool } = require('../v3-server');

const router = express.Router();

// ========================================
// Get all branches (HO view / own branch)
// ========================================
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.userId;
    const userBranchId = req.user?.branchId;
    const role = req.user?.role;

    let query = 'SELECT * FROM branches WHERE status = $1';
    const params = ['active'];

    // Non-HO users see only their branch
    if (role !== 'Super Admin' && role !== 'HO Manager') {
      query += ' AND id = $2';
      params.push(userBranchId);
    }

    const result = await pool.query(query, params);
    res.json({ success: true, branches: result.rows });
  } catch (error) {
    console.error('Fetch branches error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// Get branch by ID
// ========================================
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role;
    const userBranchId = req.user?.branchId;

    const query = 'SELECT * FROM branches WHERE id = $1';
    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Branch not found' });
    }

    // Check access: HO can view all, others only their own
    const branch = result.rows[0];
    if (userRole !== 'Super Admin' && userRole !== 'HO Manager' && branch.id !== userBranchId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    res.json({ success: true, branch });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// Create branch (HO only)
// ========================================
router.post('/', async (req, res) => {
  try {
    const userRole = req.user?.role;

    // Only HO managers can create branches
    if (userRole !== 'Super Admin' && userRole !== 'HO Manager') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { code, name, address, phone, email, region } = req.body;

    if (!code || !name) {
      return res.status(400).json({ error: 'Code and name are required' });
    }

    const query = `
      INSERT INTO branches (code, name, address, phone, email, region)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;

    const result = await pool.query(query, [code, name, address, phone, email, region]);

    res.status(201).json({ success: true, branch: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Branch code already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// Update branch
// ========================================
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role;
    const userBranchId = req.user?.branchId;

    // Check access
    const branchResult = await pool.query('SELECT id FROM branches WHERE id = $1', [id]);
    if (branchResult.rows.length === 0) {
      return res.status(404).json({ error: 'Branch not found' });
    }

    // Only HO can update other branches, branch manager can update own
    if (userRole !== 'Super Admin' && userRole !== 'HO Manager' && id !== userBranchId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { name, address, phone, email, region } = req.body;

    const query = `
      UPDATE branches
      SET name = COALESCE($1, name),
          address = COALESCE($2, address),
          phone = COALESCE($3, phone),
          email = COALESCE($4, email),
          region = COALESCE($5, region),
          updated_at = NOW()
      WHERE id = $6
      RETURNING *
    `;

    const result = await pool.query(query, [name, address, phone, email, region, id]);

    res.json({ success: true, branch: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// Get branch statistics
// ========================================
router.get('/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role;
    const userBranchId = req.user?.branchId;

    if (userRole !== 'Super Admin' && userRole !== 'HO Manager' && id !== userBranchId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const stats = {};

    // Client count
    const clientQuery = 'SELECT COUNT(*) as count FROM clients WHERE branch_id = $1 AND status = $2';
    const clientResult = await pool.query(clientQuery, [id, 'active']);
    stats.activeClients = parseInt(clientResult.rows[0].count);

    // Loan count & portfolio
    const loanQuery = `
      SELECT 
        COUNT(*) as count,
        SUM(amount) as total_amount,
        SUM(CASE WHEN status = 'active' THEN amount ELSE 0 END) as active_amount
      FROM loans
      WHERE branch_id = $1
    `;
    const loanResult = await pool.query(loanQuery, [id]);
    stats.loans = {
      count: parseInt(loanResult.rows[0].count),
      totalAmount: parseFloat(loanResult.rows[0].total_amount || 0),
      activeAmount: parseFloat(loanResult.rows[0].active_amount || 0)
    };

    // Total collections
    const paymentQuery = 'SELECT SUM(amount) as total FROM payments WHERE branch_id = $1';
    const paymentResult = await pool.query(paymentQuery, [id]);
    stats.totalCollections = parseFloat(paymentResult.rows[0].total || 0);

    res.json({ success: true, stats });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
