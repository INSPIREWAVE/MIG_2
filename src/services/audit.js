// ========================================
// v3 Audit & Compliance Middleware
// Immutable audit log for all changes
// ========================================

const { pool } = require('../db');

// Log audit events (full signature — used internally and by routes/audit.js via req.audit)
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

/**
 * Convenience alias used by services (branches-service, approvals-service, collateral-service …).
 * Signature: log(action, entityType, entityId, oldData, newData)
 * userId and branchId are omitted because services don't always have them; they default to null.
 */
async function log(action, entityType, entityId, oldData, newData) {
  await logAudit(null, action, entityType, entityId, null, { old: oldData, new: newData });
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
      query += ` AND user_id = $${paramIndex++}`;
      params.push(userId);
    }

    if (action) {
      query += ` AND action = $${paramIndex++}`;
      params.push(action);
    }

    if (entityType) {
      query += ` AND entity_type = $${paramIndex++}`;
      params.push(entityType);
    }

    if (entityId) {
      query += ` AND entity_id = $${paramIndex++}`;
      params.push(entityId);
    }

    if (branchId) {
      query += ` AND branch_id = $${paramIndex++}`;
      params.push(branchId);
    }

    if (startDate) {
      query += ` AND created_at >= $${paramIndex++}`;
      params.push(new Date(startDate));
    }

    if (endDate) {
      query += ` AND created_at <= $${paramIndex++}`;
      params.push(new Date(endDate));
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get accurate total count (separate query without LIMIT/OFFSET)
    let countQuery = 'SELECT COUNT(*) AS total FROM audit_logs WHERE 1=1';
    const countParams = [];
    let countIndex = 1;
    if (userId)     { countQuery += ` AND user_id = $${countIndex++}`;     countParams.push(userId); }
    if (action)     { countQuery += ` AND action = $${countIndex++}`;      countParams.push(action); }
    if (entityType) { countQuery += ` AND entity_type = $${countIndex++}`; countParams.push(entityType); }
    if (entityId)   { countQuery += ` AND entity_id = $${countIndex++}`;   countParams.push(entityId); }
    if (branchId)   { countQuery += ` AND branch_id = $${countIndex++}`;   countParams.push(branchId); }
    if (startDate)  { countQuery += ` AND created_at >= $${countIndex++}`; countParams.push(new Date(startDate)); }
    if (endDate)    { countQuery += ` AND created_at <= $${countIndex++}`; countParams.push(new Date(endDate)); }
    const countResult = await pool.query(countQuery, countParams);

    return {
      logs: result.rows,
      total: parseInt(countResult.rows[0].total, 10),
      limit,
      offset
    };
  } catch (error) {
    console.error('Get audit logs error:', error);
    throw error;
  }
}

/**
 * getLogs — alias expected by routes/audit.js
 */
async function getLogs(filters = {}) {
  return getAuditLogs(filters);
}

/**
 * Get audit trail for a specific entity
 */
async function getEntityTrail(entityType, entityId) {
  try {
    const result = await pool.query(
      `SELECT * FROM audit_logs
       WHERE entity_type = $1 AND entity_id = $2
       ORDER BY created_at DESC`,
      [entityType, entityId]
    );
    return result.rows;
  } catch (error) {
    console.error('Get entity trail error:', error);
    throw error;
  }
}

/**
 * Get activity log for a specific user
 */
async function getUserActivity(userId, startDate, endDate, limit = 50, offset = 0) {
  try {
    let query = 'SELECT * FROM audit_logs WHERE user_id = $1';
    const params = [userId];
    let paramIndex = 2;

    if (startDate) {
      query += ` AND created_at >= $${paramIndex++}`;
      params.push(new Date(startDate));
    }

    if (endDate) {
      query += ` AND created_at <= $${paramIndex++}`;
      params.push(new Date(endDate));
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    return result.rows;
  } catch (error) {
    console.error('Get user activity error:', error);
    throw error;
  }
}

/**
 * Generate compliance report for a date range
 */
async function generateComplianceReport(startDate, endDate) {
  try {
    const params = [];
    let where = '1=1';
    let paramIndex = 1;

    if (startDate) {
      where += ` AND created_at >= $${paramIndex++}`;
      params.push(new Date(startDate));
    }
    if (endDate) {
      where += ` AND created_at <= $${paramIndex++}`;
      params.push(new Date(endDate));
    }

    const [summary, byAction, byUser] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total_events FROM audit_logs WHERE ${where}`, params),
      pool.query(
        `SELECT action, COUNT(*) AS count FROM audit_logs WHERE ${where} GROUP BY action ORDER BY count DESC LIMIT 20`,
        params
      ),
      pool.query(
        `SELECT u.username, COUNT(al.id) AS event_count
         FROM audit_logs al
         LEFT JOIN users u ON al.user_id = u.id
         WHERE ${where}
         GROUP BY u.username ORDER BY event_count DESC LIMIT 10`,
        params
      ),
    ]);

    return {
      period: { startDate, endDate },
      totalEvents: parseInt(summary.rows[0].total_events),
      byAction: byAction.rows,
      topUsers: byUser.rows,
    };
  } catch (error) {
    console.error('Generate compliance report error:', error);
    throw error;
  }
}

module.exports = {
  logAudit,
  log,
  auditMiddleware,
  getAuditLogs,
  getLogs,
  getEntityTrail,
  getUserActivity,
  generateComplianceReport,
};
