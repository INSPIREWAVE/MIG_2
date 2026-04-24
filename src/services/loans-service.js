/**
 * MIGL v3.0.0 - Loans Service
 * Loan origination, approval, disbursement, and management
 */

const db = require('../db');
const logger = require('../utils/logger');
const { notFoundError, validationError } = require('../middleware/error-handler');
const { validateAmount, validateDate, validateEnum } = require('../validation');

/**
 * Generate loan number
 * Format: {INITIALS}-MMYY-L00001
 */
async function generateLoanNumber(branchId, companyInitials) {
  try {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = String(now.getFullYear()).slice(-2);
    const prefix = `${companyInitials}-${month}${year}-L`;
    
    const result = await db.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(loan_number, LENGTH($1) + 1) AS INTEGER)), 0) + 1 as next_num
       FROM loans WHERE branch_id = $2 AND loan_number LIKE $1 || '%'`,
      [prefix, branchId]
    );
    
    const nextNum = result.rows[0].next_num;
    const loanNumber = `${prefix}${String(nextNum).padStart(5, '0')}`;
    
    return loanNumber;
  } catch (error) {
    logger.error('Loan number generation failed', { error: error.message });
    throw error;
  }
}

/**
 * Originate loan
 */
async function originateLoan(data, branchId, userId) {
  try {
    // Validate inputs
    const amountVal = validateAmount(data.amount, 100);
    if (!amountVal.valid) throw validationError(amountVal.error, 'amount');
    
    const rateVal = validateAmount(data.interest_rate, 0, 100);
    if (!rateVal.valid) throw validationError(rateVal.error, 'interest_rate');
    
    const durationVal = validateEnum(data.duration_months, ['3', '6', '12', '24', '36']);
    if (!durationVal.valid) throw validationError(durationVal.error, 'duration_months');
    
    // Verify client exists
    const clientResult = await db.query(
      'SELECT id FROM clients WHERE id = $1 AND branch_id = $2',
      [data.client_id, branchId]
    );
    
    if (clientResult.rows.length === 0) {
      throw notFoundError('Client');
    }
    
    // Get company initials
    const settingsResult = await db.query(
      'SELECT company_initials FROM branches WHERE id = $1',
      [branchId]
    );
    
    const companyInitials = settingsResult.rows[0].company_initials || 'MIG';
    
    // Generate loan number
    const loanNumber = await generateLoanNumber(branchId, companyInitials);
    
    // Create loan in transaction
    return await db.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO loans (
          branch_id, client_id, loan_number, amount, interest_rate, 
          duration_months, purpose, status, created_by, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, NOW())
         RETURNING id, loan_number, amount, interest_rate, created_at`,
        [branchId, data.client_id, loanNumber, amountVal.value, rateVal.value,
         durationVal.value, data.purpose || null, userId]
      );
      
      const newLoan = result.rows[0];
      
      // Log audit
      await client.query(
        `INSERT INTO audit_logs (branch_id, user_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, 'LOAN_ORIGINATED', 'loan', $3, $4)`,
        [branchId, userId, newLoan.id, JSON.stringify({ loan_number: newLoan.loan_number })]
      );
      
      logger.info('Loan originated', { loanID: newLoan.id, loanNumber });
      
      return newLoan;
    });
  } catch (error) {
    logger.error('Loan origination failed', { error: error.message });
    throw error;
  }
}

/**
 * Get loan by ID
 */
async function getLoan(loanId, branchId) {
  const result = await db.query(
    `SELECT l.*, c.name as client_name, c.client_number
     FROM loans l
     LEFT JOIN clients c ON l.client_id = c.id
     WHERE l.id = $1 AND l.branch_id = $2`,
    [loanId, branchId]
  );
  
  if (result.rows.length === 0) {
    return null;
  }
  
  return result.rows[0];
}

/**
 * Submit loan for approval
 */
async function submitForApproval(loanId, branchId, userId) {
  try {
    const loan = await getLoan(loanId, branchId);
    if (!loan) {
      throw notFoundError('Loan');
    }
    
    if (loan.status !== 'pending') {
      throw validationError('Only pending loans can be submitted for approval', 'status');
    }
    
    return await db.transaction(async (client) => {
      // Update loan status
      const result = await client.query(
        'UPDATE loans SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        ['approval_pending', loanId]
      );
      
      // Create approval workflow entry
      await client.query(
        `INSERT INTO approval_workflows (loan_id, branch_id, submitted_by, submitted_at, status)
         VALUES ($1, $2, $3, NOW(), 'pending')`,
        [loanId, branchId, userId]
      );
      
      // Log audit
      await client.query(
        `INSERT INTO audit_logs (branch_id, user_id, action, entity_type, entity_id)
         VALUES ($1, $2, 'LOAN_SUBMITTED_APPROVAL', 'loan', $3)`,
        [branchId, userId, loanId]
      );
      
      logger.info('Loan submitted for approval', { loanID: loanId });
      
      return result.rows[0];
    });
  } catch (error) {
    logger.error('Loan approval submission failed', { error: error.message });
    throw error;
  }
}

/**
 * Approve loan
 */
async function approveLoan(loanId, branchId, approverId, comments = null) {
  try {
    const loan = await getLoan(loanId, branchId);
    if (!loan) {
      throw notFoundError('Loan');
    }
    
    if (loan.status !== 'approval_pending') {
      throw validationError('Loan is not pending approval', 'status');
    }
    
    return await db.transaction(async (client) => {
      // Update loan status
      const result = await client.query(
        'UPDATE loans SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        ['approved', loanId]
      );
      
      // Update approval workflow
      await client.query(
        `UPDATE approval_workflows SET status = 'approved', approved_by = $1, approved_at = NOW()
         WHERE loan_id = $2`,
        [approverId, loanId]
      );
      
      // Log audit
      await client.query(
        `INSERT INTO audit_logs (branch_id, user_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, 'LOAN_APPROVED', 'loan', $3, $4)`,
        [branchId, approverId, loanId, JSON.stringify({ comments })]
      );
      
      logger.info('Loan approved', { loanID: loanId, approverID: approverId });
      
      return result.rows[0];
    });
  } catch (error) {
    logger.error('Loan approval failed', { error: error.message });
    throw error;
  }
}

/**
 * Disburse loan
 */
async function disburseLoan(loanId, disbursedAmount, branchId, userId) {
  try {
    const loan = await getLoan(loanId, branchId);
    if (!loan) {
      throw notFoundError('Loan');
    }
    
    if (loan.status !== 'approved') {
      throw validationError('Only approved loans can be disbursed', 'status');
    }
    
    const amountVal = validateAmount(disbursedAmount, 0.01, loan.amount * 1.1);
    if (!amountVal.valid) throw validationError(amountVal.error, 'disbursedAmount');
    
    return await db.transaction(async (client) => {
      // Update loan status
      const result = await client.query(
        `UPDATE loans SET status = 'disbursed', disbursed_date = NOW(), 
         disbursed_amount = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [amountVal.value, loanId]
      );
      
      // Log audit
      await client.query(
        `INSERT INTO audit_logs (branch_id, user_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, 'LOAN_DISBURSED', 'loan', $3, $4)`,
        [branchId, userId, loanId, JSON.stringify({ amount: amountVal.value })]
      );
      
      logger.info('Loan disbursed', { loanID: loanId, amount: amountVal.value });
      
      return result.rows[0];
    });
  } catch (error) {
    logger.error('Loan disbursement failed', { error: error.message });
    throw error;
  }
}

/**
 * List loans
 */
async function listLoans(branchId, status = null, limit = 50, offset = 0) {
  let query = `SELECT l.id, l.loan_number, l.amount, l.interest_rate, l.status, 
               l.created_at, c.name as client_name, c.client_number
               FROM loans l
               LEFT JOIN clients c ON l.client_id = c.id
               WHERE l.branch_id = $1`;
  
  const params = [branchId];
  
  if (status) {
    query += ` AND l.status = $${params.length + 1}`;
    params.push(status);
  }
  
  query += ` ORDER BY l.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);
  
  const result = await db.query(query, params);
  
  return result.rows;
}

/**
 * Get loan statistics
 */
async function getLoanStats(branchId) {
  const result = await db.query(
    `SELECT
       COUNT(*) as total_loans,
       COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
       COUNT(CASE WHEN status = 'approval_pending' THEN 1 END) as approval_pending,
       COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved,
       COUNT(CASE WHEN status = 'disbursed' THEN 1 END) as disbursed,
       COUNT(CASE WHEN status = 'paid' THEN 1 END) as paid,
       COUNT(CASE WHEN status = 'defaulted' THEN 1 END) as defaulted,
       COALESCE(SUM(amount), 0) as total_principal
     FROM loans WHERE branch_id = $1`,
    [branchId]
  );
  
  return result.rows[0];
}

module.exports = {
  generateLoanNumber,
  originateLoan,
  getLoan,
  submitForApproval,
  approveLoan,
  disburseLoan,
  listLoans,
  getLoanStats,
};
