/**
 * MIGL v3.0.0 - Branches Service
 * Manages branch setup, configuration, and multi-branch operations
 */

const db = require('../db');
const logger = require('../utils/logger');
const auditService = require('./audit');

class BranchesService {
  /**
   * Create a new branch
   */
  async createBranch(data, parentBranchId, userId) {
    const {
      name,
      code,
      location,
      phoneNumber,
      email,
      managerName,
      maxClientLimit,
      maxLoanLimit,
    } = data;
    
    // Validate unique code
    const checkQuery = 'SELECT id FROM branches WHERE code = $1 AND deleted_at IS NULL';
    const checkResult = await db.query(checkQuery, [code]);
    
    if (checkResult.rows.length > 0) {
      throw new Error('Branch code already exists');
    }
    
    const query = `
      INSERT INTO branches (
        name, code, location, phone_number, email, manager_name,
        parent_branch_id, max_client_limit, max_loan_limit, created_by, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')
      RETURNING *;
    `;
    
    const result = await db.query(query, [
      name,
      code,
      location,
      phoneNumber,
      email,
      managerName,
      parentBranchId || null,
      maxClientLimit || 100,
      maxLoanLimit || 1000000,
      userId,
    ]);
    
    const branch = result.rows[0];
    
    await auditService.log('BRANCH_CREATED', 'branches', branch.id, null, branch);
    
    logger.info(`Branch created: ${branch.id} (${code})`);
    
    return branch;
  }
  
  /**
   * Get branch by ID
   */
  async getBranch(branchId) {
    const query = 'SELECT * FROM branches WHERE id = $1 AND deleted_at IS NULL';
    const result = await db.query(query, [branchId]);
    
    return result.rows[0];
  }
  
  /**
   * List all active branches
   */
  async listBranches(parentBranchId = null) {
    let query = 'SELECT * FROM branches WHERE deleted_at IS NULL AND status = \'active\'';
    const params = [];
    
    if (parentBranchId) {
      query += ' AND parent_branch_id = $1';
      params.push(parentBranchId);
    }
    
    query += ' ORDER BY name ASC';
    
    const result = await db.query(query, params);
    return result.rows;
  }
  
  /**
   * Update branch
   */
  async updateBranch(branchId, data, userId) {
    const { name, location, phoneNumber, email, managerName, maxClientLimit, maxLoanLimit } = data;
    
    const query = `
      UPDATE branches
      SET
        name = COALESCE($1, name),
        location = COALESCE($2, location),
        phone_number = COALESCE($3, phone_number),
        email = COALESCE($4, email),
        manager_name = COALESCE($5, manager_name),
        max_client_limit = COALESCE($6, max_client_limit),
        max_loan_limit = COALESCE($7, max_loan_limit),
        updated_at = NOW(),
        updated_by = $8
      WHERE id = $9 AND deleted_at IS NULL
      RETURNING *;
    `;
    
    const result = await db.query(query, [
      name,
      location,
      phoneNumber,
      email,
      managerName,
      maxClientLimit,
      maxLoanLimit,
      userId,
      branchId,
    ]);
    
    if (result.rows.length === 0) {
      throw new Error('Branch not found');
    }
    
    const branch = result.rows[0];
    
    await auditService.log('BRANCH_UPDATED', 'branches', branchId, data, branch);
    
    logger.info(`Branch updated: ${branchId}`);
    
    return branch;
  }
  
  /**
   * Get branch statistics
   */
  async getBranchStats(branchId) {
    const clientsQuery = 'SELECT COUNT(*) as total FROM clients WHERE branch_id = $1 AND deleted_at IS NULL';
    const loansQuery = 'SELECT COUNT(*) as total FROM loans WHERE branch_id = $1 AND deleted_at IS NULL';
    const activeLoansQuery = 'SELECT COUNT(*) as total FROM loans WHERE branch_id = $1 AND status = \'active\' AND deleted_at IS NULL';
    
    const [clients, loans, activeLoans] = await Promise.all([
      db.query(clientsQuery, [branchId]),
      db.query(loansQuery, [branchId]),
      db.query(activeLoansQuery, [branchId]),
    ]);
    
    return {
      totalClients: parseInt(clients.rows[0].total),
      totalLoans: parseInt(loans.rows[0].total),
      activeLoans: parseInt(activeLoans.rows[0].total),
    };
  }
}

module.exports = new BranchesService();
