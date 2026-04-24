/**
 * MIGL v3.0.0 - Authentication Middleware
 * JWT verification, role-based access control
 */

const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

/**
 * Verify JWT token
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  
  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Access token required',
    });
  }
  
  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
    if (err) {
      logger.warn(`JWT verification failed: ${err.message}`);
      
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          error: 'Token expired',
        });
      }
      
      return res.status(403).json({
        success: false,
        error: 'Invalid token',
      });
    }
    
    req.user = user;
    next();
  });
}

/**
 * Require specific role(s)
 */
function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
    }
    
    if (!allowedRoles.includes(req.user.role)) {
      logger.warn(`Unauthorized access attempt: ${req.user.id} tried to access ${req.path}`);
      
      return res.status(403).json({
        success: false,
        error: 'Insufficient permissions',
      });
    }
    
    next();
  };
}

/**
 * Require minimum role level
 * Levels: 1=Loan Officer, 2=Branch Manager, 3=Head Office Manager, 4=Admin
 */
function requireRoleLevel(minLevel) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
    }
    
    const userLevel = req.user.role_level || 1;
    
    if (userLevel < minLevel) {
      logger.warn(`Insufficient privilege level: ${req.user.id} (level ${userLevel}) tried to access level ${minLevel} resource`);
      
      return res.status(403).json({
        success: false,
        error: 'Insufficient privilege level',
      });
    }
    
    next();
  };
}

/**
 * Branch scoping - ensure user can only access own branch data
 */
function scopeToBranch(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
    });
  }
  
  // Add branch_id to request for scoping queries
  req.user.branch_id = req.user.branch_id || req.query.branch_id;
  
  // Check if user is trying to access different branch (unless HO admin)
  if (req.query.branch_id && req.query.branch_id !== req.user.branch_id && !['HEAD_OFFICE_ADMIN', 'ADMIN'].includes(req.user.role)) {
    logger.warn(`Cross-branch access attempt: ${req.user.id} (branch ${req.user.branch_id}) tried to access branch ${req.query.branch_id}`);
    
    return res.status(403).json({
      success: false,
      error: 'Cannot access data from other branches',
    });
  }
  
  next();
}

module.exports = {
  authenticateToken,
  requireRole,
  requireRoleLevel,
  scopeToBranch,
};
