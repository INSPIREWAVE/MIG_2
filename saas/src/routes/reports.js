/**
 * MIGL v3.0.0 - Reports Routes
 * REST API endpoints for reporting and analytics
 */

const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/error-handler');
const reportsService = require('../services/reports-service');

/**
 * Get portfolio summary
 * GET /api/reports/portfolio
 */
router.get('/portfolio', asyncHandler(async (req, res) => {
  const { startDate = new Date(new Date().setDate(new Date().getDate() - 30)).toISOString().split('T')[0],
          endDate = new Date().toISOString().split('T')[0] } = req.query;
  
  const summary = await reportsService.getPortfolioSummary(
    req.user.branch_id,
    startDate,
    endDate
  );
  
  res.json({
    success: true,
    report: {
      type: 'portfolio_summary',
      startDate,
      endDate,
      ...summary,
    },
  });
}));

/**
 * Get collections vs target
 * GET /api/reports/collections
 */
router.get('/collections', asyncHandler(async (req, res) => {
  const now = new Date();
  const month = req.query.month || now.getMonth() + 1;
  const year = req.query.year || now.getFullYear();
  
  const collections = await reportsService.getCollectionsVsTarget(
    req.user.branch_id,
    month,
    year
  );
  
  res.json({
    success: true,
    report: {
      type: 'collections_vs_target',
      month,
      year,
      ...collections,
    },
  });
}));

/**
 * Get PAR (Portfolio at Risk)
 * GET /api/reports/par
 */
router.get('/par', asyncHandler(async (req, res) => {
  const par = await reportsService.getPortfolioAtRisk(req.user.branch_id);
  
  res.json({
    success: true,
    report: {
      type: 'portfolio_at_risk',
      generatedAt: new Date().toISOString(),
      ...par,
    },
  });
}));

/**
 * Get aging analysis
 * GET /api/reports/aging
 */
router.get('/aging', asyncHandler(async (req, res) => {
  const aging = await reportsService.getAgingAnalysis(req.user.branch_id);
  
  res.json({
    success: true,
    report: {
      type: 'aging_analysis',
      generatedAt: new Date().toISOString(),
      ...aging,
    },
  });
}));

module.exports = router;
