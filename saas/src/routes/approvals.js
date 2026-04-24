/**
 * MIGL v3.0.0 - Approvals Routes
 * REST API endpoints for multi-level approval workflow
 */

const express = require('express');
const router = express.Router();
const { asyncHandler, notFoundError } = require('../middleware/error-handler');
const approvalsService = require('../services/approvals-service');

/**
 * Create approval request
 * POST /api/approvals
 */
router.post('/', asyncHandler(async (req, res) => {
  const { loanId, requiredLevel } = req.body;
  
  const approval = await approvalsService.createApprovalRequest(loanId, requiredLevel, req.user.id);
  
  res.status(201).json({
    success: true,
    message: 'Approval request created',
    approval,
  });
}));

/**
 * Get pending approvals
 * GET /api/approvals/pending
 */
router.get('/pending', asyncHandler(async (req, res) => {
  const approvals = await approvalsService.getPendingApprovals(req.user.role_level, req.user.branch_id);
  
  res.json({
    success: true,
    approvals,
    count: approvals.length,
  });
}));

/**
 * Approve a request
 * POST /api/approvals/:approvalId/approve
 */
router.post('/:approvalId/approve', asyncHandler(async (req, res) => {
  const { notes } = req.body;
  
  const approval = await approvalsService.approveRequest(
    req.params.approvalId,
    req.user.id,
    req.user.role_level,
    notes
  );
  
  res.json({
    success: true,
    message: 'Approval request approved',
    approval,
  });
}));

/**
 * Reject a request
 * POST /api/approvals/:approvalId/reject
 */
router.post('/:approvalId/reject', asyncHandler(async (req, res) => {
  const { reason } = req.body;
  
  const approval = await approvalsService.rejectRequest(
    req.params.approvalId,
    req.user.id,
    reason
  );
  
  res.json({
    success: true,
    message: 'Approval request rejected',
    approval,
  });
}));

/**
 * Get approval history for loan
 * GET /api/approvals/loan/:loanId
 */
router.get('/loan/:loanId', asyncHandler(async (req, res) => {
  const history = await approvalsService.getApprovalHistory(req.params.loanId);
  
  res.json({
    success: true,
    approvals: history,
    count: history.length,
  });
}));

module.exports = router;
