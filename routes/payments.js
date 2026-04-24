/**
 * MIGL v3.0.0 - Payments Routes
 * REST API endpoints for payment operations
 */

const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../error-handler');
const paymentService = require('../services/payment-service');
const { validateAmount, validateDate } = require('../validation');

/**
 * Record a payment
 * POST /api/payments
 */
router.post('/', asyncHandler(async (req, res) => {
  const { loanId, amount, paymentMethod, reference, paymentDate } = req.body;
  
  const payment = await paymentService.recordPayment(
    loanId,
    amount,
    paymentMethod,
    reference,
    paymentDate,
    req.user.id,
    req.user.branch_id
  );
  
  // Get updated balance
  const balance = await paymentService.calculateBalance(loanId);
  
  res.status(201).json({
    success: true,
    message: 'Payment recorded successfully',
    payment,
    loanBalance: balance,
  });
}));

/**
 * Get payment by ID
 * GET /api/payments/:paymentId
 */
router.get('/:paymentId', asyncHandler(async (req, res) => {
  const payment = await paymentService.getPayment(req.params.paymentId, req.user.branch_id);
  
  if (!payment) {
    return res.status(404).json({
      error: {
        code: 404,
        message: 'Payment not found',
      },
    });
  }
  
  res.json({
    success: true,
    payment,
  });
}));

/**
 * List payments for a loan
 * GET /api/payments/loan/:loanId
 */
router.get('/loan/:loanId', asyncHandler(async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  
  const payments = await paymentService.listPaymentsForLoan(
    req.params.loanId,
    req.user.branch_id,
    parseInt(limit),
    parseInt(offset)
  );
  
  res.json({
    success: true,
    payments,
    count: payments.length,
  });
}));

/**
 * Get loan balance
 * GET /api/payments/balance/:loanId
 */
router.get('/balance/:loanId', asyncHandler(async (req, res) => {
  const balance = await paymentService.calculateBalance(req.params.loanId);
  
  res.json({
    success: true,
    balance,
  });
}));

module.exports = router;
