/**
 * MIGL v3.0.0 - Loans Routes
 * REST API endpoints for loan operations
 */

const express = require('express');
const router = express.Router();
const { asyncHandler, notFoundError } = require('../middleware/error-handler');
const loansService = require('../services/loans-service');

/**
 * Create (originate) a loan
 * POST /api/loans
 */
router.post('/', asyncHandler(async (req, res) => {
  const loan = await loansService.originateLoan(req.body, req.user.branch_id, req.user.id);
  
  res.status(201).json({
    success: true,
    message: 'Loan created successfully',
    loan,
  });
}));

/**
 * Get loan by ID
 * GET /api/loans/:loanId
 */
router.get('/:loanId', asyncHandler(async (req, res) => {
  const loan = await loansService.getLoan(req.params.loanId, req.user.branch_id);
  
  if (!loan) {
    throw notFoundError('Loan');
  }
  
  res.json({
    success: true,
    loan,
  });
}));

/**
 * List loans
 * GET /api/loans
 */
router.get('/', asyncHandler(async (req, res) => {
  const {
    status,
    limit = 50,
    offset = 0,
  } = req.query;
  
  const loans = await loansService.listLoans(
    req.user.branch_id,
    status || null,
    parseInt(limit),
    parseInt(offset),
  );
  
  res.json({
    success: true,
    loans,
    count: loans.length,
  });
}));

/**
 * Approve loan
 * POST /api/loans/:loanId/approve
 */
router.post('/:loanId/approve', asyncHandler(async (req, res) => {
  const { notes } = req.body;
  
  const loan = await loansService.approveLoan(
    req.params.loanId,
    req.user.branch_id,
    req.user.id,
    notes,
  );
  
  res.json({
    success: true,
    message: 'Loan approved successfully',
    loan,
  });
}));

/**
 * Disburse loan
 * POST /api/loans/:loanId/disburse
 */
router.post('/:loanId/disburse', asyncHandler(async (req, res) => {
  const { amount } = req.body;
  
  const loan = await loansService.disburseLoan(
    req.params.loanId,
    amount,
    req.user.branch_id,
    req.user.id,
  );
  
  res.json({
    success: true,
    message: 'Loan disbursed successfully',
    loan,
  });
}));

/**
 * Update loan
 * PUT /api/loans/:loanId
 */
router.put('/:loanId', asyncHandler(async (req, res) => {
  const updated = await loansService.updateLoan(
    req.params.loanId,
    req.body,
    req.user.branch_id,
    req.user.id,
  );
  
  res.json({
    success: true,
    message: 'Loan updated successfully',
    loan: updated,
  });
}));

module.exports = router;
