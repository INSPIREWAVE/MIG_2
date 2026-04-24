/**
 * MIGL v3.0.0 - Logger Module
 * Centralized logging with levels and timestamps
 */

const fs = require('fs');
const path = require('path');

// Ensure logs directory exists
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

const logFile = path.join(logsDir, `app-${new Date().toISOString().split('T')[0]}.log`);

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
  TRACE: 4,
};

const currentLogLevel = process.env.LOG_LEVEL ? 
  LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()] : LOG_LEVELS.INFO;

/**
 * Format log message
 */
function formatMessage(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const dataStr = Object.keys(data).length > 0 ? ` | ${JSON.stringify(data)}` : '';
  return `[${timestamp}] [${level}] ${message}${dataStr}`;
}

/**
 * Write to log file
 */
function writeLog(message) {
  try {
    fs.appendFileSync(logFile, message + '\n');
  } catch (error) {
    console.error('Failed to write log:', error);
  }
}

/**
 * Log error
 */
function error(message, data = {}) {
  if (currentLogLevel >= LOG_LEVELS.ERROR) {
    const formatted = formatMessage('ERROR', message, data);
    console.error(formatted);
    writeLog(formatted);
  }
}

/**
 * Log warning
 */
function warn(message, data = {}) {
  if (currentLogLevel >= LOG_LEVELS.WARN) {
    const formatted = formatMessage('WARN', message, data);
    console.warn(formatted);
    writeLog(formatted);
  }
}

/**
 * Log info
 */
function info(message, data = {}) {
  if (currentLogLevel >= LOG_LEVELS.INFO) {
    const formatted = formatMessage('INFO', message, data);
    console.log(formatted);
    writeLog(formatted);
  }
}

/**
 * Log debug
 */
function debug(message, data = {}) {
  if (currentLogLevel >= LOG_LEVELS.DEBUG) {
    const formatted = formatMessage('DEBUG', message, data);
    console.debug(formatted);
    writeLog(formatted);
  }
}

/**
 * Log trace
 */
function trace(message, data = {}) {
  if (currentLogLevel >= LOG_LEVELS.TRACE) {
    const formatted = formatMessage('TRACE', message, data);
    console.trace(formatted);
    writeLog(formatted);
  }
}

module.exports = {
  error,
  warn,
  info,
  debug,
  trace,
};
