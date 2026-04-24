/**
 * MIGL v3.0.0 - Audit Routes
 * REST API endpoints for audit log and compliance
 */

const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/error-handler');
const auditService = require('../services/audit');
const { requireRole } = require('../middleware/auth');

/**
 * Get audit logs
 * GET /api/audit
 */
router.get('/', requireRole(['ADMIN', 'COMPLIANCE_OFFICER']), asyncHandler(async (req, res) => {
  const {
    action,
    entityType,
    entityId,
    userId,
    startDate,
    endDate,
    limit = 100,
    offset = 0,
  } = req.query;
  
  const logs = await auditService.getLogs({
    action,
    entityType,
    entityId,
    userId,
    startDate,
    endDate,
    limit: parseInt(limit),
    offset: parseInt(offset),
  });
  
  res.json({
    success: true,
    logs,
    count: logs.length,
  });
}));

/**
 * Get audit trail for entity
 * GET /api/audit/entity/:entityType/:entityId
 */
router.get('/entity/:entityType/:entityId', requireRole(['ADMIN', 'COMPLIANCE_OFFICER']), asyncHandler(async (req, res) => {
  const { entityType, entityId } = req.params;
  
  const logs = await auditService.getEntityTrail(entityType, entityId);
  
  res.json({
    success: true,
    trail: logs,
    count: logs.length,
  });
}));

/**
 * Get user activity
 * GET /api/audit/user/:userId
 */
router.get('/user/:userId', requireRole(['ADMIN']), asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { startDate, endDate, limit = 50, offset = 0 } = req.query;
  
  const logs = await auditService.getUserActivity(
    userId,
    startDate,
    endDate,
    parseInt(limit),
    parseInt(offset)
  );
  
  res.json({
    success: true,
    activity: logs,
    count: logs.length,
  });
}));

/**
 * Generate compliance report
 * GET /api/audit/report/compliance
 */
router.get('/report/compliance', requireRole(['COMPLIANCE_OFFICER', 'ADMIN']), asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;
  
  const report = await auditService.generateComplianceReport(startDate, endDate);
  
  res.json({
    success: true,
    report,
  });
}));

module.exports = router;
