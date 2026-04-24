// ========================================
// v3 Audit & Compliance Middleware
// Immutable audit log for all changes
// ========================================

const { pool } = require('../db');

// Log audit events
async function logAudit(userId, action, entityType, entityId, branchId, changes = {}, req = null) {
  try {
    const query = `
      INSERT INTO audit_logs (user_id, action, entity_type, entity_id, branch_id, changes, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;

    const ipAddress = req?.ip || '0.0.0.0';
    const userAgent = req?.get('user-agent') || 'unknown';

    await pool.query(query, [
      userId,
      action,
      entityType,
      entityId,
      branchId,
      JSON.stringify(changes),
      ipAddress,
      userAgent
    ]);
  } catch (error) {
    console.error('Audit log error:', error);
  }
}

// Middleware: auto-log route changes
function auditMiddleware(req, res, next) {
  // Attach audit helper to request
  req.audit = logAudit;
  next();
}

// Fetch audit logs with filtering
async function getAuditLogs(filters = {}) {
  try {
    const {
      userId,
      action,
      entityType,
      entityId,
      branchId,
      startDate,
      endDate,
      limit = 100,
      offset = 0
    } = filters;

    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (userId) {
      query += ` AND user_id = $${paramIndex}`;
      params.push(userId);
      paramIndex++;
    }

    if (action) {
      query += ` AND action = $${paramIndex}`;
      params.push(action);
      paramIndex++;
    }

    if (entityType) {
      query += ` AND entity_type = $${paramIndex}`;
      params.push(entityType);
      paramIndex++;
    }

    if (entityId) {
      query += ` AND entity_id = $${paramIndex}`;
      params.push(entityId);
      paramIndex++;
    }

    if (branchId) {
      query += ` AND branch_id = $${paramIndex}`;
      params.push(branchId);
      paramIndex++;
    }

    if (startDate) {
      query += ` AND created_at >= $${paramIndex}`;
      params.push(new Date(startDate));
      paramIndex++;
    }

    if (endDate) {
      query += ` AND created_at <= $${paramIndex}`;
      params.push(new Date(endDate));
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as count FROM audit_logs WHERE 1=1';
    const countParams = [];
    let countIndex = 1;

    if (userId) {
      countQuery += ` AND user_id = $${countIndex}`;
      countParams.push(userId);
      countIndex++;
    }

    if (action) {
      countQuery += ` AND action = $${countIndex}`;
      countParams.push(action);
      countIndex++;
    }

    if (entityType) {
      countQuery += ` AND entity_type = $${countIndex}`;
      countParams.push(entityType);
      countIndex++;
    }

    const countResult = await pool.query(countQuery, countParams);

    return {
      logs: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit,
      offset
    };
  } catch (error) {
    console.error('Get audit logs error:', error);
    throw error;
  }
}

module.exports = {
  logAudit,
  auditMiddleware,
  getAuditLogs
};
