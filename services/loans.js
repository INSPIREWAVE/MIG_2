// ========================================
// v3 Loans Service - Business Logic
// Origination, approval, disbursement
// ========================================

const { pool } = require('../db-v3');
const { logAudit } = require('./audit');

class LoanService {
  // Originate loan (creates in pending status)
  static async originateLoan(loanData, userId, branchId, req) {
    try {
      const {
        client_id,
        amount,
        interest_rate,
        duration_months,
        start_date,
        daily_penalty_rate,
        grace_period_days,
        collateral_value
      } = loanData;

      if (!client_id || !amount || !duration_months) {
        throw new Error('Missing required fields');
      }

      // Verify client exists and belongs to branch
      const clientQuery = 'SELECT id FROM clients WHERE id = $1 AND branch_id = $2';
      const clientResult = await pool.query(clientQuery, [client_id, branchId]);
      if (clientResult.rows.length === 0) {
        throw new Error('Client not found');
      }

      // Generate loan number
      const loanNum = await this.generateLoanNumber(branchId);

      // Calculate due date
      const startDateObj = new Date(start_date || new Date());
      const dueDate = new Date(startDateObj);
      dueDate.setMonth(dueDate.getMonth() + duration_months);

      const query = `
        INSERT INTO loans 
        (loan_number, client_id, branch_id, originated_by, amount, interest_rate,
         duration_months, start_date, due_date, status, approval_status, 
         daily_penalty_rate, grace_period_days, collateral_value)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *
      `;

      const result = await pool.query(query, [
        loanNum, client_id, branchId, userId, amount, interest_rate || 0,
        duration_months, startDateObj, dueDate, 'pending', 'pending',
        daily_penalty_rate || 5.0, grace_period_days || 0, collateral_value || 0
      ]);

      const loan = result.rows[0];

      // Create approval workflow
      const approvalQuery = `
        INSERT INTO approval_workflows 
        (entity_type, entity_id, branch_id, created_by, expires_at)
        VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')
      `;

      await pool.query(approvalQuery, ['loan', loan.id, branchId, userId]);

      // Log audit
      await logAudit(userId, 'ORIGINATE_LOAN', 'loans', loan.id, branchId, loanData, req);

      return {
        loan,
        message: 'Loan originated and pending approval'
      };
    } catch (error) {
      throw error;
    }
  }

  // Get loans (scoped by branch)
  static async getLoans(branchId, filters = {}) {
    try {
      const { status, limit = 100, offset = 0 } = filters;

      let query = `
        SELECT l.*, 
               c.first_name, c.last_name, c.phone, c.email,
               u.full_name as originated_by_name,
               COALESCE(SUM(p.amount), 0) as total_paid
        FROM loans l
        JOIN clients c ON l.client_id = c.id
        LEFT JOIN users u ON l.originated_by = u.id
        LEFT JOIN payments p ON l.id = p.loan_id
        WHERE l.branch_id = $1
      `;

      const params = [branchId];
      let paramIndex = 2;

      if (status) {
        query += ` AND l.status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      query += ` GROUP BY l.id, c.id, u.id
                 ORDER BY l.created_at DESC
                 LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;

      params.push(limit, offset);

      const result = await pool.query(query, params);

      // Compute derived fields for each loan
      const loans = result.rows.map(loan => ({
        ...loan,
        totalAmount: parseFloat(loan.amount) + (parseFloat(loan.amount) * loan.interest_rate / 100),
        paidAmount: parseFloat(loan.total_paid),
        balance: Math.max(0, parseFloat(loan.amount) + (parseFloat(loan.amount) * loan.interest_rate / 100) - parseFloat(loan.total_paid))
      }));

      // Get total count
      let countQuery = 'SELECT COUNT(*) as count FROM loans WHERE branch_id = $1';
      const countParams = [branchId];

      if (status) {
        countQuery += ` AND status = $2`;
        countParams.push(status);
      }

      const countResult = await pool.query(countQuery, countParams);

      return {
        loans,
        total: parseInt(countResult.rows[0].count),
        limit,
        offset
      };
    } catch (error) {
      throw error;
    }
  }

  // Get loan by ID with full details
  static async getLoanById(loanId, branchId) {
    try {
      const query = `
        SELECT l.*, 
               c.first_name, c.last_name, c.phone, c.email, c.id_number,
               u.full_name as originated_by_name,
               COALESCE(SUM(p.amount), 0) as total_paid
        FROM loans l
        JOIN clients c ON l.client_id = c.id
        LEFT JOIN users u ON l.originated_by = u.id
        LEFT JOIN payments p ON l.id = p.loan_id
        WHERE l.id = $1 AND l.branch_id = $2
        GROUP BY l.id, c.id, u.id
      `;

      const result = await pool.query(query, [loanId, branchId]);

      if (result.rows.length === 0) {
        throw new Error('Loan not found');
      }

      const loan = result.rows[0];

      // Compute derived fields
      return {
        ...loan,
        totalAmount: parseFloat(loan.amount) + (parseFloat(loan.amount) * loan.interest_rate / 100),
        paidAmount: parseFloat(loan.total_paid),
        balance: Math.max(0, parseFloat(loan.amount) + (parseFloat(loan.amount) * loan.interest_rate / 100) - parseFloat(loan.total_paid))
      };
    } catch (error) {
      throw error;
    }
  }

  // Approve loan (requires approval permission)
  static async approveLoan(loanId, approvedBy, branchId, comment = '', req) {
    try {
      // Get approval workflow
      const workflowQuery = `
        SELECT id FROM approval_workflows 
        WHERE entity_type = 'loan' AND entity_id = $1 AND status = 'pending'
      `;

      const workflowResult = await pool.query(workflowQuery, [loanId]);

      if (workflowResult.rows.length === 0) {
        throw new Error('No pending approval found for this loan');
      }

      // Update loan approval
      const loanQuery = `
        UPDATE loans
        SET approval_status = 'approved', approved_by = $1, updated_at = NOW()
        WHERE id = $2 AND branch_id = $3
        RETURNING *
      `;

      const loanResult = await pool.query(loanQuery, [approvedBy, loanId, branchId]);

      // Update approval workflow
      const updateWorkflowQuery = `
        UPDATE approval_workflows
        SET status = 'approved', approved_by = $1, approval_comment = $2, updated_at = NOW()
        WHERE id = $3
      `;

      await pool.query(updateWorkflowQuery, [approvedBy, comment, workflowResult.rows[0].id]);

      // Log audit
      await logAudit(approvedBy, 'APPROVE_LOAN', 'loans', loanId, branchId, { comment }, req);

      return loanResult.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Disburse loan (mark as active and approved for payments)
  static async disburseLoan(loanId, disburseBy, branchId, req) {
    try {
      const query = `
        UPDATE loans
        SET status = 'active', approval_status = 'approved', updated_at = NOW()
        WHERE id = $1 AND branch_id = $2 AND approval_status = 'approved'
        RETURNING *
      `;

      const result = await pool.query(query, [loanId, branchId]);

      if (result.rows.length === 0) {
        throw new Error('Loan cannot be disbursed (not approved)');
      }

      // Log audit
      await logAudit(disburseBy, 'DISBURSE_LOAN', 'loans', loanId, branchId, {}, req);

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Record payment against loan
  static async recordPayment(loanId, paymentData, userId, branchId, req) {
    try {
      const { amount, payment_date, payment_method, receipt_number, notes } = paymentData;

      if (!amount || amount <= 0) {
        throw new Error('Amount must be greater than 0');
      }

      const query = `
        INSERT INTO payments 
        (loan_id, branch_id, amount, payment_date, payment_method, recorded_by, receipt_number, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `;

      const result = await pool.query(query, [
        loanId, branchId, amount, payment_date || new Date(), payment_method, userId, receipt_number, notes
      ]);

      const payment = result.rows[0];

      // Check if loan is now paid (balance <= 0)
      const loanResult = await this.getLoanById(loanId, branchId);
      if (loanResult.balance <= 0) {
        await pool.query('UPDATE loans SET status = $1 WHERE id = $2', ['paid', loanId]);
      }

      // Log audit
      await logAudit(userId, 'RECORD_PAYMENT', 'payments', payment.id, branchId, paymentData, req);

      return payment;
    } catch (error) {
      throw error;
    }
  }

  // Generate unique loan number
  static async generateLoanNumber(branchId) {
    try {
      const query = `
        SELECT COUNT(*) as count FROM loans 
        WHERE branch_id = $1
      `;

      const result = await pool.query(query, [branchId]);
      const count = parseInt(result.rows[0].count) + 1;

      // Get branch code
      const branchQuery = 'SELECT code FROM branches WHERE id = $1';
      const branchResult = await pool.query(branchQuery, [branchId]);
      const branchCode = branchResult.rows[0]?.code || 'BR';

      const today = new Date();
      const monthYear = `${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getFullYear()).slice(-2)}`;

      return `${branchCode}-${monthYear}-L${String(count).padStart(5, '0')}`;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = LoanService;
