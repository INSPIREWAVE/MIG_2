/**
 * MIGL v3.0.0 - PostgreSQL Database Module
 * Provides connection pool, query helper, and transaction support.
 *
 * Environment variables (all optional, fall back to defaults for local dev):
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSL
 */

'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'migl_v3',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max:                20,
  idleTimeoutMillis:  30000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', () => {
  if (process.env.LOG_LEVEL === 'DEBUG') {
    console.log('[DB] New client connected');
  }
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/**
 * Run a single parameterised query.
 * Returns the full pg Result object so callers can access .rows, .rowCount, etc.
 *
 * @param {string} text   - SQL string
 * @param {Array}  params - Query parameters
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    if (process.env.LOG_LEVEL === 'DEBUG') {
      console.log('[DB] query', { text: text.slice(0, 80), duration: Date.now() - start, rows: result.rowCount });
    }
    return result;
  } catch (err) {
    console.error('[DB] query error:', err.message, { text: text.slice(0, 120) });
    throw err;
  }
}

/**
 * Run multiple queries inside a single transaction.
 * The callback receives a pg PoolClient so it can call client.query(...).
 * If the callback throws the transaction is automatically rolled back.
 *
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Gracefully shut down the pool (useful for tests and clean exits).
 */
async function end() {
  await pool.end();
}

module.exports = { pool, query, transaction, end };
