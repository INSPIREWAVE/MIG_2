/**
 * MIGL v3.0.0 - Express API Server
 *
 * Entry point for the v3 multi-branch backend.
 * Run with:  npm run dev   (uses package-v3.json's "start" script)
 * Or:        node v3-server.js
 *
 * Required environment variables (see .env.example):
 *   PORT, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
 *   JWT_SECRET, JWT_REFRESH_SECRET
 */

'use strict';

require('dotenv').config();

const express       = require('express');
const helmet        = require('helmet');
const cors          = require('cors');
const morgan        = require('morgan');
const rateLimit     = require('express-rate-limit');

const { pool }               = require('./db-v3');
const logger                 = require('./logger');
const { errorHandler, notFoundHandler } = require('./error-handler');
const { authenticateToken }  = require('./middleware/auth');
const { auditMiddleware }    = require('./services/audit');

// ── Routes ────────────────────────────────────────────────────────────────────
const authRoutes       = require('./routes/auth');
const usersRoutes      = require('./routes/users');
const branchesRoutes   = require('./routes/branches');
const clientsRoutes    = require('./routes/clients');
const loansRoutes      = require('./routes/loans');
const paymentsRoutes   = require('./routes/payments');
const collateralRoutes = require('./routes/collateral');
const approvalsRoutes  = require('./routes/approvals');
const reportsRoutes    = require('./routes/reports');
const auditRoutes      = require('./routes/audit');

// ── App setup ─────────────────────────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT || '4000', 10);

// Security headers
app.use(helmet());

// CORS — default to same-origin in production; override with CORS_ORIGIN env var.
// Set CORS_ORIGIN='*' explicitly if you need to allow all origins (e.g. local dev).
const corsOrigin = process.env.CORS_ORIGIN || (process.env.NODE_ENV === 'production' ? false : '*');
app.use(cors({
  origin:         corsOrigin,
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials:    true,
}));

// Global rate limiting (200 req / 15 min per IP)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      200,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, error: 'Too many requests – please try again later.' },
});
app.use(globalLimiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// HTTP request logging (skip in test)
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}

// ── Public routes (no auth required) ─────────────────────────────────────────

/** Health check — also tests DB connectivity */
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', version: '3.0.0', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

app.use('/api/auth', authRoutes);

// ── Protected routes (JWT required) ──────────────────────────────────────────
app.use(authenticateToken);
app.use(auditMiddleware);

app.use('/api/users',      usersRoutes);
app.use('/api/branches',   branchesRoutes);
app.use('/api/clients',    clientsRoutes);
app.use('/api/loans',      loansRoutes);
app.use('/api/payments',   paymentsRoutes);
app.use('/api/collateral', collateralRoutes);
app.use('/api/approvals',  approvalsRoutes);
app.use('/api/reports',    reportsRoutes);
app.use('/api/audit',      auditRoutes);

// ── Error handlers (must be last) ─────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ── Start listening ───────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`MIGL v3 API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });
}

// Export app and pool so services that do require('../v3-server') can destructure { pool }
module.exports = { app, pool };
