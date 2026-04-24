/**
 * MIGL v3.0.0 - Payment Service
 * Handles payment recording, tracking, and balance calculations
 */

const db = require('../db-v3');
const logger = require('../logger');
const { notFoundError, validationError } = require('../error-handler');
const { validateAmount, validateDate, validateString } = require('../validation');

/**
 * Record a payment
 */
async function recordPayment(loanId, amount, paymentMethod, reference, paymentDate, userId, branchId) {
  try {
    // Validate inputs
    const amountVal = validateAmount(amount, 0.01);
    if (!amountVal.valid) throw validationError(amountVal.error, 'amount');
    
    const methodVal = validateString(paymentMethod, 1, 50);
    if (!methodVal.valid) throw validationError(methodVal.error, 'paymentMethod');
    
    // Get loan
    const loanResult = await db.query(
      'SELECT id, client_id, amount, interest_rate FROM loans WHERE id = $1 AND branch_id = $2',
      [loanId, branchId]
    );
    
    if (loanResult.rows.length === 0) {
      throw notFoundError('Loan');
    }
    
    const loan = loanResult.rows[0];
    
    // Record payment in transaction
    return await db.transaction(async (client) => {
      // Insert payment
      const paymentResult = await client.query(
        `INSERT INTO payments (loan_id, amount, payment_method, reference, payment_date, user_id, branch_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, amount, payment_date, created_at`,
        [loanId, amountVal.value, methodVal.value, reference, paymentDate, userId, branchId]
      );
      
      const payment = paymentResult.rows[0];
      
      // Trigger auto-penalty check
      await applyAutoPenalties(loan.id, branchId, client);
      
      // Log audit
      await client.query(
        `INSERT INTO audit_logs (branch_id, user_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, 'PAYMENT_RECORDED', 'payment', $3, $4)`,
        [branchId, userId, payment.id, JSON.stringify({ amount: payment.amount, loanId })]
      );
      
      logger.info('Payment recorded', { paymentID: payment.id, loanID: loanId, amount: amountVal.value });
      
      return payment;
    });
  } catch (error) {
    logger.error('Payment recording failed', { error: error.message });
    throw error;
  }
}

/**
 * Get payment by ID
 */
async function getPayment(paymentId, branchId) {
  const result = await db.query(
    `SELECT p.*, u.username as recorded_by
     FROM payments p
     LEFT JOIN users u ON p.user_id = u.id
     WHERE p.id = $1 AND p.branch_id = $2`,
    [paymentId, branchId]
  );
  
  if (result.rows.length === 0) {
    return null;
  }
  
  return result.rows[0];
}

/**
 * List payments for a loan
 */
async function listPaymentsForLoan(loanId, branchId, limit = 50, offset = 0) {
  const result = await db.query(
    `SELECT p.*, u.username as recorded_by
     FROM payments p
     LEFT JOIN users u ON p.user_id = u.id
     WHERE p.loan_id = $1 AND p.branch_id = $2
     ORDER BY p.payment_date DESC
     LIMIT $3 OFFSET $4`,
    [loanId, branchId, limit, offset]
  );
  
  return result.rows;
}

/**
 * Get total paid amount for loan
 */
async function getTotalPaid(loanId) {
  const result = await db.query(
    'SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE loan_id = $1',
    [loanId]
  );
  
  return parseFloat(result.rows[0].total);
}

/**
 * Calculate loan balance
 */
async function calculateBalance(loanId) {
  const loanResult = await db.query(
    `SELECT amount, interest_rate FROM loans WHERE id = $1`,
    [loanId]
  );
  
  if (loanResult.rows.length === 0) {
    throw notFoundError('Loan');
  }
  
  const loan = loanResult.rows[0];
  
  // Get total paid
  const totalPaid = await getTotalPaid(loanId);
  
  // Get total penalties
  const penaltyResult = await db.query(
    'SELECT COALESCE(SUM(amount), 0) as total FROM penalties WHERE loan_id = $1',
    [loanId]
  );
  
  const totalPenalties = parseFloat(penaltyResult.rows[0].total);
  
  // Calculate total owed
  const totalAmount = loan.amount + (loan.amount * loan.interest_rate / 100) + totalPenalties;
  const balance = Math.max(0, totalAmount - totalPaid);
  
  return {
    totalAmount: parseFloat(totalAmount.toFixed(2)),
    totalPaid: parseFloat(totalPaid.toFixed(2)),
    balance: parseFloat(balance.toFixed(2)),
    isPaid: balance <= 0,
  };
}

/**
 * Apply auto-penalties
 */
async function applyAutoPenalties(loanId, branchId, client) {
  try {
    const query = client ? client.query.bind(client) : db.query;
    
    // Get loan with dates
    const loanResult = await query(
      `SELECT l.id, l.amount, l.disbursed_date, b.grace_period_days, b.daily_penalty_rate
       FROM loans l
       JOIN branches b ON l.branch_id = b.id
       WHERE l.id = $1 AND l.status != 'paid'`,
      [loanId]
    );
    
    if (loanResult.rows.length === 0) return;
    
    const loan = loanResult.rows[0];
    const gracePeriodExpiry = new Date(loan.disbursed_date);
    gracePeriodExpiry.setDate(gracePeriodExpiry.getDate() + (loan.grace_period_days || 0));
    
    // Check if grace period has passed
    if (new Date() <= gracePeriodExpiry) {
      return;
    }
    
    // Get last penalty applied
    const lastPenaltyResult = await query(
      'SELECT created_at FROM penalties WHERE loan_id = $1 ORDER BY created_at DESC LIMIT 1',
      [loanId]
    );
    
    let lastPenaltyDate = loan.disbursed_date;
    if (lastPenaltyResult.rows.length > 0) {
      lastPenaltyDate = lastPenaltyResult.rows[0].created_at;
    }
    
    // Calculate days since last penalty
    const now = new Date();
    const lastDate = new Date(lastPenaltyDate);
    const daysDiff = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));
    
    // Apply daily penalty if at least 1 day has passed
    if (daysDiff >= 1) {
      const dailyRate = loan.daily_penalty_rate || 0.5; // Default 0.5% daily
      const penaltyAmount = loan.amount * (dailyRate / 100) * daysDiff;
      
      await query(
        `INSERT INTO penalties (loan_id, amount, penalty_type, created_at)
         VALUES ($1, $2, 'AUTO_DAILY', NOW())`,
        [loanId, parseFloat(penaltyAmount.toFixed(2))]
      );
      
      logger.info('Auto-penalty applied', { loanID: loanId, amount: penaltyAmount });
    }
  } catch (error) {
    logger.error('Auto-penalty application failed', { error: error.message });
  }
}

module.exports = {
  recordPayment,
  getPayment,
  listPaymentsForLoan,
  getTotalPaid,
  calculateBalance,
  applyAutoPenalties,
};
