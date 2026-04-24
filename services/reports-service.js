/**
 * MIGL v3.0.0 - Reports Service
 * Generates portfolio reports and analytics
 */

const db = require('../db-v3');
const logger = require('../logger');

/**
 * Get portfolio summary
 */
async function getPortfolioSummary(branchId, startDate, endDate) {
  try {
    const result = await db.query(
      `SELECT
         COUNT(DISTINCT l.id) as total_loans,
         COUNT(DISTINCT c.id) as total_clients,
         COALESCE(SUM(l.amount), 0) as total_principal,
         COALESCE(SUM(l.amount * l.interest_rate / 100), 0) as total_interest,
         COALESCE(SUM(p.amount), 0) as total_paid,
         COUNT(CASE WHEN l.status = 'disbursed' THEN 1 END) as active_loans,
         COUNT(CASE WHEN l.status = 'paid' THEN 1 END) as paid_loans,
         COUNT(CASE WHEN l.status = 'pending' THEN 1 END) as pending_loans
       FROM loans l
       LEFT JOIN clients c ON l.client_id = c.id
       LEFT JOIN payments p ON l.id = p.loan_id
       WHERE l.branch_id = $1
         AND l.created_at BETWEEN $2 AND $3`,
      [branchId, startDate, endDate]
    );
    
    const summary = result.rows[0];
    
    return {
      totalLoans: parseInt(summary.total_loans),
      totalClients: parseInt(summary.total_clients),
      totalPrincipal: parseFloat(summary.total_principal),
      totalInterest: parseFloat(summary.total_interest),
      totalPaid: parseFloat(summary.total_paid),
      activeLoans: parseInt(summary.active_loans),
      paidLoans: parseInt(summary.paid_loans),
      pendingLoans: parseInt(summary.pending_loans),
    };
  } catch (error) {
    logger.error('Portfolio summary generation failed', { error: error.message });
    throw error;
  }
}

/**
 * Get collections vs target
 */
async function getCollectionsVsTarget(branchId, month, year) {
  try {
    // Get collections for month
    const collectionsResult = await db.query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM payments
       WHERE branch_id = $1
         AND EXTRACT(MONTH FROM payment_date) = $2
         AND EXTRACT(YEAR FROM payment_date) = $3`,
      [branchId, month, year]
    );
    
    const collections = parseFloat(collectionsResult.rows[0].total);
    
    // Get branch target (from settings)
    const targetResult = await db.query(
      'SELECT monthly_collection_target FROM branches WHERE id = $1',
      [branchId]
    );
    
    const target = targetResult.rows.length > 0 ? 
      parseFloat(targetResult.rows[0].monthly_collection_target) : 0;
    
    const percentage = target > 0 ? (collections / target) * 100 : 0;
    
    return {
      collections: collections,
      target: target,
      variance: collections - target,
      percentageOfTarget: parseFloat(percentage.toFixed(2)),
    };
  } catch (error) {
    logger.error('Collections vs target generation failed', { error: error.message });
    throw error;
  }
}

/**
 * Get PAR (Portfolio at Risk)
 */
async function getPortfolioAtRisk(branchId) {
  try {
    // Loans with late payments
    const result = await db.query(
      `SELECT
         COUNT(DISTINCT l.id) as at_risk_loans,
         COALESCE(SUM(l.amount), 0) as at_risk_amount,
         COUNT(DISTINCT CASE WHEN p.days_overdue >= 30 THEN l.id END) as loans_30_plus,
         COUNT(DISTINCT CASE WHEN p.days_overdue >= 60 THEN l.id END) as loans_60_plus,
         COUNT(DISTINCT CASE WHEN p.days_overdue >= 90 THEN l.id END) as loans_90_plus
       FROM loans l
       LEFT JOIN (
         SELECT loan_id, 
                EXTRACT(DAY FROM NOW() - MAX(payment_date)) as days_overdue
         FROM payments
         GROUP BY loan_id
       ) p ON l.id = p.loan_id
       WHERE l.branch_id = $1
         AND l.status != 'paid'
         AND p.days_overdue > 0`,
      [branchId]
    );
    
    const par = result.rows[0];
    
    return {
      atRiskLoans: parseInt(par.at_risk_loans),
      atRiskAmount: parseFloat(par.at_risk_amount),
      loans30Plus: parseInt(par.loans_30_plus),
      loans60Plus: parseInt(par.loans_60_plus),
      loans90Plus: parseInt(par.loans_90_plus),
    };
  } catch (error) {
    logger.error('PAR generation failed', { error: error.message });
    throw error;
  }
}

/**
 * Get aging analysis
 */
async function getAgingAnalysis(branchId) {
  try {
    const result = await db.query(
      `SELECT
         COUNT(CASE WHEN p.days_overdue <= 30 THEN 1 END) as days_0_30,
         COUNT(CASE WHEN p.days_overdue > 30 AND p.days_overdue <= 60 THEN 1 END) as days_31_60,
         COUNT(CASE WHEN p.days_overdue > 60 AND p.days_overdue <= 90 THEN 1 END) as days_61_90,
         COUNT(CASE WHEN p.days_overdue > 90 THEN 1 END) as days_90_plus
       FROM loans l
       LEFT JOIN (
         SELECT loan_id,
                EXTRACT(DAY FROM NOW() - MAX(payment_date)) as days_overdue
         FROM payments
         GROUP BY loan_id
       ) p ON l.id = p.loan_id
       WHERE l.branch_id = $1 AND l.status != 'paid'`,
      [branchId]
    );
    
    const aging = result.rows[0];
    
    return {
      days0to30: parseInt(aging.days_0_30),
      days31to60: parseInt(aging.days_31_60),
      days61to90: parseInt(aging.days_61_90),
      days90Plus: parseInt(aging.days_90_plus),
    };
  } catch (error) {
    logger.error('Aging analysis generation failed', { error: error.message });
    throw error;
  }
}

module.exports = {
  getPortfolioSummary,
  getCollectionsVsTarget,
  getPortfolioAtRisk,
  getAgingAnalysis,
};
