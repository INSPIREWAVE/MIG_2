/**
 * MIGL v3.0.0 - Loans Routes
 * REST API endpoints for loan operations
 */

const express = require('express');
const router = express.Router();
const { asyncHandler, notFoundError } = require('../middleware/error-handler');
const loansService = require('../services/loans-service');

/**
 * Create loan
 * POST /api/loans
 */
router.post('/', asyncHandler(async (req, res) => {
  const loan = await loansService.createLoan(req.body, req.user.id);
  
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
  const loan = await loansService.getLoan(req.params.loanId);
  
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
    clientId,
    status,
    limit = 50,
    offset = 0,
  } = req.query;
  
  const loans = await loansService.listLoans({
    clientId,
    status,
    limit: parseInt(limit),
    offset: parseInt(offset),
  });
  
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
  const { approvalDate, notes } = req.body;
  
  const loan = await loansService.approveLoan(
    req.params.loanId,
    approvalDate,
    req.user.id,
    notes
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
  const { disbursementDate, method } = req.body;
  
  const loan = await loansService.disburseLoan(
    req.params.loanId,
    disbursementDate,
    method,
    req.user.id
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
    req.user.id
  );
  
  res.json({
    success: true,
    message: 'Loan updated successfully',
    loan: updated,
  });
}));

module.exports = router;
