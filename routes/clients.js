/**
 * MIGL v3.0.0 - Clients Routes
 * REST API endpoints for client operations
 */

const express = require('express');
const router = express.Router();
const { asyncHandler, notFoundError } = require('../error-handler');
const clientsService = require('../services/clients-service');

/**
 * Create client
 * POST /api/clients
 */
router.post('/', asyncHandler(async (req, res) => {
  const client = await clientsService.createClient(req.body, req.user.branch_id, req.user.id);
  
  res.status(201).json({
    success: true,
    message: 'Client created successfully',
    client,
  });
}));

/**
 * Get client by ID
 * GET /api/clients/:clientId
 */
router.get('/:clientId', asyncHandler(async (req, res) => {
  const client = await clientsService.getClient(req.params.clientId, req.user.branch_id);
  
  if (!client) {
    throw notFoundError('Client');
  }
  
  res.json({
    success: true,
    client,
  });
}));

/**
 * List clients
 * GET /api/clients
 */
router.get('/', asyncHandler(async (req, res) => {
  const { limit = 50, offset = 0, search = null } = req.query;
  
  const clients = await clientsService.listClients(
    req.user.branch_id,
    parseInt(limit),
    parseInt(offset),
    search
  );
  
  res.json({
    success: true,
    clients,
    count: clients.length,
  });
}));

/**
 * Update client
 * PUT /api/clients/:clientId
 */
router.put('/:clientId', asyncHandler(async (req, res) => {
  const updated = await clientsService.updateClient(
    req.params.clientId,
    req.body,
    req.user.branch_id,
    req.user.id
  );
  
  res.json({
    success: true,
    message: 'Client updated successfully',
    client: updated,
  });
}));

/**
 * Archive client
 * DELETE /api/clients/:clientId
 */
router.delete('/:clientId', asyncHandler(async (req, res) => {
  const archived = await clientsService.archiveClient(
    req.params.clientId,
    req.user.branch_id,
    req.user.id
  );
  
  res.json({
    success: true,
    message: 'Client archived successfully',
    client: archived,
  });
}));

module.exports = router;
