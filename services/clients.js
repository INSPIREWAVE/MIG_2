// ========================================
// v3 Service Layer - Clients
// Business logic for client management
// ========================================

const { pool } = require('../db-v3');
const { logAudit } = require('./audit');

class ClientService {
  // Create client
  static async createClient(clientData, userId, branchId, req) {
    try {
      const {
        first_name,
        last_name,
        phone,
        email,
        id_number,
        id_type,
        address,
        occupation,
        monthly_income
      } = clientData;

      if (!first_name || !last_name || !branchId) {
        throw new Error('Missing required fields');
      }

      // Generate client number
      const clientNum = await this.generateClientNumber(branchId);

      const query = `
        INSERT INTO clients 
        (client_number, branch_id, first_name, last_name, phone, email, 
         id_number, id_type, address, occupation, monthly_income, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `;

      const result = await pool.query(query, [
        clientNum, branchId, first_name, last_name, phone, email,
        id_number, id_type, address, occupation, monthly_income, userId
      ]);

      const client = result.rows[0];

      // Log audit
      await logAudit(userId, 'CREATE_CLIENT', 'clients', client.id, branchId, clientData, req);

      return client;
    } catch (error) {
      throw error;
    }
  }

  // Get clients (scoped by branch)
  static async getClients(branchId, filters = {}) {
    try {
      const { status = 'active', limit = 100, offset = 0 } = filters;

      let query = `
        SELECT * FROM clients 
        WHERE branch_id = $1 AND status = $2
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4
      `;

      const result = await pool.query(query, [branchId, status, limit, offset]);

      // Get total count
      const countQuery = 'SELECT COUNT(*) as count FROM clients WHERE branch_id = $1 AND status = $2';
      const countResult = await pool.query(countQuery, [branchId, status]);

      return {
        clients: result.rows,
        total: parseInt(countResult.rows[0].count),
        limit,
        offset
      };
    } catch (error) {
      throw error;
    }
  }

  // Get client by ID
  static async getClientById(clientId, branchId) {
    try {
      const query = 'SELECT * FROM clients WHERE id = $1 AND branch_id = $2';
      const result = await pool.query(query, [clientId, branchId]);

      if (result.rows.length === 0) {
        throw new Error('Client not found');
      }

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Update client
  static async updateClient(clientId, updates, userId, branchId, req) {
    try {
      const {
        first_name, last_name, phone, email, address,
        occupation, monthly_income, status
      } = updates;

      const query = `
        UPDATE clients
        SET first_name = COALESCE($1, first_name),
            last_name = COALESCE($2, last_name),
            phone = COALESCE($3, phone),
            email = COALESCE($4, email),
            address = COALESCE($5, address),
            occupation = COALESCE($6, occupation),
            monthly_income = COALESCE($7, monthly_income),
            status = COALESCE($8, status),
            updated_by = $9,
            updated_at = NOW()
        WHERE id = $10 AND branch_id = $11
        RETURNING *
      `;

      const result = await pool.query(query, [
        first_name, last_name, phone, email, address,
        occupation, monthly_income, status, userId, clientId, branchId
      ]);

      if (result.rows.length === 0) {
        throw new Error('Client not found');
      }

      await logAudit(userId, 'UPDATE_CLIENT', 'clients', clientId, branchId, updates, req);

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Delete client
  static async deleteClient(clientId, userId, branchId, req) {
    try {
      // Check if client has active loans
      const loansQuery = 'SELECT COUNT(*) as count FROM loans WHERE client_id = $1 AND status != $2';
      const loansResult = await pool.query(loansQuery, [clientId, 'paid']);

      if (parseInt(loansResult.rows[0].count) > 0) {
        throw new Error('Cannot delete client with active loans');
      }

      // Soft delete
      const query = `
        UPDATE clients
        SET status = 'inactive', updated_by = $1, updated_at = NOW()
        WHERE id = $2 AND branch_id = $3
        RETURNING *
      `;

      const result = await pool.query(query, [userId, clientId, branchId]);

      await logAudit(userId, 'DELETE_CLIENT', 'clients', clientId, branchId, {}, req);

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Generate unique client number
  static async generateClientNumber(branchId) {
    try {
      const query = `
        SELECT COUNT(*) as count FROM clients 
        WHERE branch_id = $1
      `;

      const result = await pool.query(query, [branchId]);
      const count = parseInt(result.rows[0].count) + 1;

      // Get branch code for prefix
      const branchQuery = 'SELECT code FROM branches WHERE id = $1';
      const branchResult = await pool.query(branchQuery, [branchId]);
      const branchCode = branchResult.rows[0]?.code || 'BR';

      return `${branchCode}-${String(count).padStart(5, '0')}`;
    } catch (error) {
      throw error;
    }
  }

  // Get client dashboard (with summary stats)
  static async getClientProfile(clientId, branchId) {
    try {
      const client = await this.getClientById(clientId, branchId);

      // Get loan summary
      const loanQuery = `
        SELECT 
          COUNT(*) as total_loans,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active_loans,
          SUM(CASE WHEN status = 'active' THEN amount ELSE 0 END) as active_amount
        FROM loans
        WHERE client_id = $1
      `;

      const loanResult = await pool.query(loanQuery, [clientId]);

      // Get total collected
      const paymentQuery = `
        SELECT SUM(p.amount) as total_collected
        FROM payments p
        JOIN loans l ON p.loan_id = l.id
        WHERE l.client_id = $1
      `;

      const paymentResult = await pool.query(paymentQuery, [clientId]);

      return {
        client,
        loans: loanResult.rows[0],
        totalCollected: parseFloat(paymentResult.rows[0].total_collected || 0)
      };
    } catch (error) {
      throw error;
    }
  }
}

module.exports = ClientService;
