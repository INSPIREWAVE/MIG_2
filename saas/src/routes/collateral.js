/**
 * MIGL v3.0.0 - Collateral Routes
 * REST API endpoints for collateral operations
 */

const express = require('express');
const router = express.Router();
const { asyncHandler, notFoundError } = require('../middleware/error-handler');
const collateralService = require('../services/collateral-service');

/**
 * Register collateral
 * POST /api/collateral
 */
router.post('/', asyncHandler(async (req, res) => {
  const collateral = await collateralService.registerCollateral(req.body.loanId, req.body);
  
  res.status(201).json({
    success: true,
    message: 'Collateral registered successfully',
    collateral,
  });
}));

/**
 * List collateral for loan
 * GET /api/collateral/loan/:loanId
 */
router.get('/loan/:loanId', asyncHandler(async (req, res) => {
  const collaterals = await collateralService.listByLoan(req.params.loanId);
  
  res.json({
    success: true,
    collaterals,
    count: collaterals.length,
  });
}));

/**
 * Get collateral by ID
 * GET /api/collateral/:collateralId
 */
router.get('/:collateralId', asyncHandler(async (req, res) => {
  const collateral = await collateralService.getCollateral(req.params.collateralId);
  
  if (!collateral) {
    throw notFoundError('Collateral');
  }
  
  res.json({
    success: true,
    collateral,
  });
}));

/**
 * Update collateral valuation
 * PUT /api/collateral/:collateralId/valuation
 */
router.put('/:collateralId/valuation', asyncHandler(async (req, res) => {
  const { value, notes } = req.body;
  
  const collateral = await collateralService.updateValuation(req.params.collateralId, value, notes);
  
  res.json({
    success: true,
    message: 'Collateral revalued successfully',
    collateral,
  });
}));

/**
 * Release collateral
 * POST /api/collateral/:collateralId/release
 */
router.post('/:collateralId/release', asyncHandler(async (req, res) => {
  const { reason } = req.body;
  
  const collateral = await collateralService.releaseCollateral(
    req.params.collateralId,
    reason,
    req.user.id
  );
  
  res.json({
    success: true,
    message: 'Collateral released successfully',
    collateral,
  });
}));

module.exports = router;
