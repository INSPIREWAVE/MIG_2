/**
 * MIGL v3.0.0 - Approvals Service
 * Handles multi-level loan approvals and decisions
 * Uses the approval_workflows table (v3 schema).
 */

const db = require('../db');
const logger = require('../utils/logger');
const auditService = require('./audit');

class ApprovalsService {
  /**
   * Create approval request
   * Maps: loan_id → entity_id (entity_type = 'loan'), userId → created_by
   */
  async createApprovalRequest(loanId, requiredLevel, userId) {
    const query = `
      INSERT INTO approval_workflows (entity_type, entity_id, created_by, status)
      VALUES ('loan', $1, $2, 'pending')
      RETURNING *;
    `;

    const result = await db.query(query, [loanId, userId]);
    const approval = result.rows[0];

    await auditService.log('APPROVAL_REQUESTED', 'approval_workflows', approval.id, null, approval);

    logger.info(`Approval requested: ${approval.id} for loan ${loanId}`);

    return approval;
  }

  /**
   * Get pending approvals for a branch
   * requiredLevel is checked against the role tier of the approver (passed in by route)
   */
  async getPendingApprovals(minLevel, branchId) {
    const query = `
      SELECT aw.*, l.client_id, l.amount,
             c.first_name || ' ' || c.last_name AS client_name
      FROM approval_workflows aw
      JOIN loans l ON aw.entity_id = l.id AND aw.entity_type = 'loan'
      JOIN clients c ON l.client_id = c.id
      WHERE aw.status = 'pending' AND l.branch_id = $1
      ORDER BY aw.created_at ASC;
    `;

    const result = await db.query(query, [branchId]);
    return result.rows;
  }

  /**
   * Approve a request
   */
  async approveRequest(approvalId, userId, userLevel, notes) {
    const getQuery = 'SELECT * FROM approval_workflows WHERE id = $1';
    const getResult = await db.query(getQuery, [approvalId]);

    if (getResult.rows.length === 0) {
      throw new Error('Approval request not found');
    }

    const approval = getResult.rows[0];

    if (approval.status !== 'pending') {
      throw new Error(`Approval is already ${approval.status}`);
    }

    const updateQuery = `
      UPDATE approval_workflows
      SET status = 'approved', approved_by = $1, approval_comment = $2, updated_at = NOW()
      WHERE id = $3
      RETURNING *;
    `;

    const updateResult = await db.query(updateQuery, [userId, notes || null, approvalId]);
    const updated = updateResult.rows[0];

    await auditService.log('APPROVAL_APPROVED', 'approval_workflows', approvalId, approval, updated);

    logger.info(`Approval approved: ${approvalId} by user ${userId}`);

    return updated;
  }

  /**
   * Reject an approval request
   */
  async rejectRequest(approvalId, userId, reason) {
    const getQuery = 'SELECT * FROM approval_workflows WHERE id = $1';
    const getResult = await db.query(getQuery, [approvalId]);

    if (getResult.rows.length === 0) {
      throw new Error('Approval request not found');
    }

    const approval = getResult.rows[0];

    if (approval.status !== 'pending') {
      throw new Error(`Approval is already ${approval.status}`);
    }

    const updateQuery = `
      UPDATE approval_workflows
      SET status = 'rejected', rejected_by = $1, rejection_reason = $2, updated_at = NOW()
      WHERE id = $3
      RETURNING *;
    `;

    const updateResult = await db.query(updateQuery, [userId, reason, approvalId]);
    const updated = updateResult.rows[0];

    await auditService.log('APPROVAL_REJECTED', 'approval_workflows', approvalId, approval, updated);

    logger.info(`Approval rejected: ${approvalId} by user ${userId}`);

    return updated;
  }

  /**
   * Get approval history for a loan
   */
  async getApprovalHistory(loanId) {
    const query = `
      SELECT * FROM approval_workflows
      WHERE entity_type = 'loan' AND entity_id = $1
      ORDER BY created_at DESC;
    `;

    const result = await db.query(query, [loanId]);
    return result.rows;
  }
}

module.exports = new ApprovalsService();
