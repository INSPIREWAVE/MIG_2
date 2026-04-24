/**
 * MIGL v3.0.0 - Clients Service
 * Client CRUD operations with auto-numbering
 */

const db = require('../db-v3');
const logger = require('../logger');
const { notFoundError, validationError, conflictError } = require('../error-handler');
const { validateEmail, validatePhone, validateString } = require('../validation');

/**
 * Generate client number
 * Format: {INITIALS}-0001
 */
async function generateClientNumber(branchId, companyInitials) {
  try {
    const result = await db.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(client_number, LENGTH($1) + 2) AS INTEGER)), 0) + 1 as next_num
       FROM clients WHERE branch_id = $2 AND client_number LIKE $1 || '-%'`,
      [companyInitials, branchId]
    );
    
    const nextNum = result.rows[0].next_num;
    const clientNumber = `${companyInitials}-${String(nextNum).padStart(4, '0')}`;
    
    return clientNumber;
  } catch (error) {
    logger.error('Client number generation failed', { error: error.message });
    throw error;
  }
}

/**
 * Create client
 */
async function createClient(data, branchId, userId) {
  try {
    // Validate inputs
    const emailVal = validateEmail(data.email);
    if (!emailVal.valid) throw validationError(emailVal.error, 'email');
    
    const phoneVal = validatePhone(data.phone);
    if (!phoneVal.valid) throw validationError(phoneVal.error, 'phone');
    
    const nameVal = validateString(data.name, 1, 255);
    if (!nameVal.valid) throw validationError(nameVal.error, 'name');
    
    // Check if email already exists
    const existing = await db.query(
      'SELECT id FROM clients WHERE email = $1 AND branch_id = $2 LIMIT 1',
      [emailVal.value, branchId]
    );
    
    if (existing.rows.length > 0) {
      throw conflictError('Client with this email already exists');
    }
    
    // Get company initials from settings
    const settingsResult = await db.query(
      'SELECT company_initials FROM branches WHERE id = $1',
      [branchId]
    );
    
    if (settingsResult.rows.length === 0) {
      throw notFoundError('Branch');
    }
    
    const companyInitials = settingsResult.rows[0].company_initials || 'MIG';
    
    // Generate client number
    const clientNumber = await generateClientNumber(branchId, companyInitials);
    
    // Create client in transaction
    return await db.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO clients (branch_id, client_number, name, email, phone, address, city, postal_code, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         RETURNING id, client_number, name, email, created_at`,
        [branchId, clientNumber, nameVal.value, emailVal.value, phoneVal.value,
         data.address || null, data.city || null, data.postal_code || null, userId]
      );
      
      const newClient = result.rows[0];
      
      // Log audit
      await client.query(
        `INSERT INTO audit_logs (branch_id, user_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, 'CLIENT_CREATED', 'client', $3, $4)`,
        [branchId, userId, newClient.id, JSON.stringify({ client_number: newClient.client_number })]
      );
      
      logger.info('Client created', { clientID: newClient.id, clientNumber });
      
      return newClient;
    });
  } catch (error) {
    logger.error('Client creation failed', { error: error.message });
    throw error;
  }
}

/**
 * Get client by ID
 */
async function getClient(clientId, branchId) {
  const result = await db.query(
    `SELECT id, client_number, name, email, phone, address, city, postal_code, is_active, created_at, updated_at
     FROM clients WHERE id = $1 AND branch_id = $2`,
    [clientId, branchId]
  );
  
  if (result.rows.length === 0) {
    return null;
  }
  
  return result.rows[0];
}

/**
 * Update client
 */
async function updateClient(clientId, data, branchId, userId) {
  try {
    // Check if client exists
    const existing = await getClient(clientId, branchId);
    if (!existing) {
      throw notFoundError('Client');
    }
    
    // Validate inputs if provided
    if (data.email) {
      const emailVal = validateEmail(data.email);
      if (!emailVal.valid) throw validationError(emailVal.error, 'email');
      data.email = emailVal.value;
    }
    
    if (data.phone) {
      const phoneVal = validatePhone(data.phone);
      if (!phoneVal.valid) throw validationError(phoneVal.error, 'phone');
      data.phone = phoneVal.value;
    }
    
    // Update client
    return await db.transaction(async (client) => {
      const updates = [];
      const params = [clientId, branchId];
      let paramCount = 2;
      
      if (data.name) {
        updates.push(`name = $${++paramCount}`);
        params.push(data.name);
      }
      if (data.email) {
        updates.push(`email = $${++paramCount}`);
        params.push(data.email);
      }
      if (data.phone) {
        updates.push(`phone = $${++paramCount}`);
        params.push(data.phone);
      }
      if (data.address) {
        updates.push(`address = $${++paramCount}`);
        params.push(data.address);
      }
      
      if (updates.length === 0) {
        return existing;
      }
      
      updates.push(`updated_at = NOW()`);
      
      const result = await client.query(
        `UPDATE clients SET ${updates.join(', ')} WHERE id = $1 AND branch_id = $2 RETURNING *`,
        params
      );
      
      const updated = result.rows[0];
      
      // Log audit
      await client.query(
        `INSERT INTO audit_logs (branch_id, user_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, 'CLIENT_UPDATED', 'client', $3, $4)`,
        [branchId, userId, clientId, JSON.stringify({ changes: data })]
      );
      
      logger.info('Client updated', { clientID: clientId });
      
      return updated;
    });
  } catch (error) {
    logger.error('Client update failed', { error: error.message });
    throw error;
  }
}

/**
 * List clients
 */
async function listClients(branchId, limit = 50, offset = 0, search = null) {
  let query = `SELECT id, client_number, name, email, phone, is_active, created_at
               FROM clients WHERE branch_id = $1`;
  const params = [branchId];
  
  if (search) {
    query += ` AND (name ILIKE $${params.length + 1} OR client_number ILIKE $${params.length + 1})`;
    params.push(`%${search}%`);
  }
  
  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);
  
  const result = await db.query(query, params);
  
  return result.rows;
}

/**
 * Archive client
 */
async function archiveClient(clientId, branchId, userId) {
  try {
    const existing = await getClient(clientId, branchId);
    if (!existing) {
      throw notFoundError('Client');
    }
    
    return await db.transaction(async (client) => {
      const result = await client.query(
        'UPDATE clients SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING *',
        [clientId]
      );
      
      // Log audit
      await client.query(
        `INSERT INTO audit_logs (branch_id, user_id, action, entity_type, entity_id)
         VALUES ($1, $2, 'CLIENT_ARCHIVED', 'client', $3)`,
        [branchId, userId, clientId]
      );
      
      logger.info('Client archived', { clientID: clientId });
      
      return result.rows[0];
    });
  } catch (error) {
    logger.error('Client archival failed', { error: error.message });
    throw error;
  }
}

module.exports = {
  generateClientNumber,
  createClient,
  getClient,
  updateClient,
  listClients,
  archiveClient,
};
