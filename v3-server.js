/**
 * MIGL v3.0.0 - Express Server
 * Multi-user, multi-branch Loan & Client Management API
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');

const { pool } = require('./db-v3');
const { authenticateToken } = require('./middleware/auth');

// ── Route modules ────────────────────────────────────────────────────────────
const authRoutes       = require('./routes/auth');
const usersRoutes      = require('./routes/users');
const clientsRoutes    = require('./routes/clients');
const loansRoutes      = require('./routes/loans');
const paymentsRoutes   = require('./routes/payments');
const branchesRoutes   = require('./routes/branches');
const approvalsRoutes  = require('./routes/approvals');
const collateralRoutes = require('./routes/collateral');
const reportsRoutes    = require('./routes/reports');
const auditRoutes      = require('./routes/audit');

// ── App setup ────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security & logging middleware ────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health check (public) ────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', message: err.message });
  }
});

// ── Public routes ─────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);

// ── Protected routes (JWT required) ──────────────────────────────────────────
app.use('/api/users',      authenticateToken, usersRoutes);
app.use('/api/clients',    authenticateToken, clientsRoutes);
app.use('/api/loans',      authenticateToken, loansRoutes);
app.use('/api/payments',   authenticateToken, paymentsRoutes);
app.use('/api/branches',   authenticateToken, branchesRoutes);
app.use('/api/approvals',  authenticateToken, approvalsRoutes);
app.use('/api/collateral', authenticateToken, collateralRoutes);
app.use('/api/reports',    authenticateToken, reportsRoutes);
app.use('/api/audit',      authenticateToken, auditRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || err.status || 500;
  const message    = err.message    || 'Internal Server Error';

  if (process.env.NODE_ENV !== 'production') {
    console.error('[error]', err);
  }

  res.status(statusCode).json({
    success: false,
    error:   message,
    ...(err.details && { details: err.details }),
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`MIGL v3 API server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

// Export pool so route files that do require('../v3-server') can destructure it
module.exports = { app, pool };
