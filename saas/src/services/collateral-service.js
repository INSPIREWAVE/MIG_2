/**
 * MIGL v3.0.0 - Collateral Service
 * Handles collateral management, valuation, and release
 */

const db = require('../db');
const logger = require('../utils/logger');
const auditService = require('./audit');

class CollateralService {
  /**
   * Register collateral for a loan
   */
  async registerCollateral(loanId, data) {
    const { type, description, value, location, photoUrl } = data;
    
    const query = `
      INSERT INTO collateral (loan_id, type, description, value, location, photo_url, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'registered')
      RETURNING *;
    `;
    
    const result = await db.query(query, [
      loanId,
      type,
      description,
      value,
      location,
      photoUrl,
    ]);
    
    const collateral = result.rows[0];
    
    await auditService.log('COLLATERAL_REGISTERED', 'collateral', collateral.id, null, collateral);
    
    logger.info(`Collateral registered: ${collateral.id}`);
    
    return collateral;
  }
  
  /**
   * Get collateral by ID
   */
  async getCollateral(collateralId) {
    const query = 'SELECT * FROM collateral WHERE id = $1 AND deleted_at IS NULL';
    const result = await db.query(query, [collateralId]);
    
    return result.rows[0];
  }
  
  /**
   * List collateral for a loan
   */
  async listByLoan(loanId) {
    const query = `
      SELECT * FROM collateral
      WHERE loan_id = $1 AND deleted_at IS NULL
      ORDER BY created_at DESC;
    `;
    
    const result = await db.query(query, [loanId]);
    return result.rows;
  }
  
  /**
   * Update collateral valuation
   */
  async updateValuation(collateralId, value, notes) {
    const query = `
      UPDATE collateral
      SET value = $1, last_valuation = NOW(), notes = $2
      WHERE id = $3 AND deleted_at IS NULL
      RETURNING *;
    `;
    
    const result = await db.query(query, [value, notes, collateralId]);
    
    if (result.rows.length === 0) {
      throw new Error('Collateral not found');
    }
    
    const collateral = result.rows[0];
    
    await auditService.log(
      'VALUATION_UPDATED',
      'collateral',
      collateralId,
      { value: this.value },
      collateral
    );
    
    logger.info(`Collateral revalued: ${collateralId}`);
    
    return collateral;
  }
  
  /**
   * Release collateral
   */
  async releaseCollateral(collateralId, reason, userId) {
    const query = `
      UPDATE collateral
      SET status = 'released', released_at = NOW(), released_by = $1, release_reason = $2
      WHERE id = $3 AND deleted_at IS NULL
      RETURNING *;
    `;
    
    const result = await db.query(query, [userId, reason, collateralId]);
    
    if (result.rows.length === 0) {
      throw new Error('Collateral not found');
    }
    
    const collateral = result.rows[0];
    
    await auditService.log('COLLATERAL_RELEASED', 'collateral', collateralId, null, collateral);
    
    logger.info(`Collateral released: ${collateralId}`);
    
    return collateral;
  }
  
  /**
   * Archive collateral (soft delete)
   */
  async archiveCollateral(collateralId) {
    const query = `
      UPDATE collateral
      SET deleted_at = NOW()
      WHERE id = $1
      RETURNING *;
    `;
    
    const result = await db.query(query, [collateralId]);
    
    if (result.rows.length === 0) {
      throw new Error('Collateral not found');
    }
    
    await auditService.log('COLLATERAL_ARCHIVED', 'collateral', collateralId);
    
    logger.info(`Collateral archived: ${collateralId}`);
    
    return result.rows[0];
  }
}

module.exports = new CollateralService();
