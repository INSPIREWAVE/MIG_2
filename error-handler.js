/**
 * MIGL v3.0.0 - Error Handler Middleware
 * Centralized error handling and HTTP response formatting
 */

const logger = require('./logger');

/**
 * Custom error class
 */
class APIError extends Error {
  constructor(statusCode, message, details = {}) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Error handler middleware
 */
function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  logger.error(`[${req.method} ${req.path}] ${statusCode} ${message}`, {
    userID: req.user?.id,
    branchID: req.user?.branch_id,
    details: err.details,
  });

  res.status(statusCode).json({
    error: {
      code: statusCode,
      message: message,
      details: process.env.NODE_ENV === 'development' ? err.details : {},
      timestamp: new Date().toISOString(),
      path: req.path,
    },
  });
}

/**
 * Not found handler
 */
function notFoundHandler(req, res, next) {
  const error = new APIError(404, `Route not found: ${req.method} ${req.path}`);
  errorHandler(error, req, res, next);
}

/**
 * Async error wrapper
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Validation error handler
 */
function validationError(message, field = null) {
  const error = new APIError(400, 'Validation Error', {
    field: field,
    message: message,
  });
  return error;
}

/**
 * Authentication error
 */
function authError(message = 'Unauthorized') {
  return new APIError(401, message, {
    code: 'AUTH_FAILED',
  });
}

/**
 * Authorization error
 */
function authzError(message = 'Forbidden') {
  return new APIError(403, message, {
    code: 'PERMISSION_DENIED',
  });
}

/**
 * Not found error
 */
function notFoundError(resource) {
  return new APIError(404, `${resource} not found`, {
    code: 'NOT_FOUND',
  });
}

/**
 * Conflict error
 */
function conflictError(message, details = {}) {
  return new APIError(409, message, {
    code: 'CONFLICT',
    ...details,
  });
}

/**
 * Server error
 */
function serverError(message = 'Internal Server Error', details = {}) {
  return new APIError(500, message, {
    code: 'SERVER_ERROR',
    ...details,
  });
}

module.exports = {
  APIError,
  errorHandler,
  notFoundHandler,
  asyncHandler,
  validationError,
  authError,
  authzError,
  notFoundError,
  conflictError,
  serverError,
};
