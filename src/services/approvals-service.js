/**
 * MIGL v3.0.0 - Approvals Service
 * Handles multi-level loan approvals and decisions
 */

const db = require('../db');
const logger = require('../utils/logger');
const auditService = require('./audit');

class ApprovalsService {
  /**
   * Create approval request
   */
  async createApprovalRequest(loanId, requiredLevel, userId) {
    const query = `
      INSERT INTO approvals (loan_id, required_level, requested_by, status)
      VALUES ($1, $2, $3, 'pending')
      RETURNING *;
    `;
    
    const result = await db.query(query, [loanId, requiredLevel, userId]);
    const approval = result.rows[0];
    
    await auditService.log('APPROVAL_REQUESTED', 'approvals', approval.id, null, approval);
    
    logger.info(`Approval requested: ${approval.id} (level: ${requiredLevel})`);
    
    return approval;
  }
  
  /**
   * Get pending approvals
   */
  async getPendingApprovals(minLevel, branchId) {
    const query = `
      SELECT a.*, l.client_id, l.amount, c.full_name
      FROM approvals a
      JOIN loans l ON a.loan_id = l.id
      JOIN clients c ON l.client_id = c.id
      WHERE a.status = 'pending' AND a.required_level >= $1 AND l.branch_id = $2
      ORDER BY a.created_at ASC;
    `;
    
    const result = await db.query(query, [minLevel, branchId]);
    return result.rows;
  }
  
  /**
   * Approve a request
   */
  async approveRequest(approvalId, userId, userLevel, notes) {
    // First get the approval to check required level
    const getQuery = 'SELECT * FROM approvals WHERE id = $1';
    const getResult = await db.query(getQuery, [approvalId]);
    
    if (getResult.rows.length === 0) {
      throw new Error('Approval request not found');
    }
    
    const approval = getResult.rows[0];
    
    // Check user level
    if (userLevel < approval.required_level) {
      throw new Error(`User level ${userLevel} insufficient for required level ${approval.required_level}`);
    }
    
    // Update approval
    const updateQuery = `
      UPDATE approvals
      SET status = 'approved', approved_by = $1, approved_at = NOW(), notes = $2
      WHERE id = $3
      RETURNING *;
    `;
    
    const updateResult = await db.query(updateQuery, [userId, notes, approvalId]);
    const updated = updateResult.rows[0];
    
    await auditService.log('APPROVAL_APPROVED', 'approvals', approvalId, approval, updated);
    
    logger.info(`Approval approved: ${approvalId} by user ${userId}`);
    
    return updated;
  }
  
  /**
   * Reject an approval request
   */
  async rejectRequest(approvalId, userId, reason) {
    const getQuery = 'SELECT * FROM approvals WHERE id = $1';
    const getResult = await db.query(getQuery, [approvalId]);
    
    if (getResult.rows.length === 0) {
      throw new Error('Approval request not found');
    }
    
    const approval = getResult.rows[0];
    
    const updateQuery = `
      UPDATE approvals
      SET status = 'rejected', rejected_by = $1, rejected_at = NOW(), rejection_reason = $2
      WHERE id = $3
      RETURNING *;
    `;
    
    const updateResult = await db.query(updateQuery, [userId, reason, approvalId]);
    const updated = updateResult.rows[0];
    
    await auditService.log('APPROVAL_REJECTED', 'approvals', approvalId, approval, updated);
    
    logger.info(`Approval rejected: ${approvalId} by user ${userId}`);
    
    return updated;
  }
  
  /**
   * Get approval history for a loan
   */
  async getApprovalHistory(loanId) {
    const query = `
      SELECT * FROM approvals
      WHERE loan_id = $1
      ORDER BY created_at DESC;
    `;
    
    const result = await db.query(query, [loanId]);
    return result.rows;
  }
}

module.exports = new ApprovalsService();
