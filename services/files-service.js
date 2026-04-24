/**
 * MIGL v3.0.0 - Files Service
 * Handles file uploads, storage, and document management
 * Supports S3/MinIO and local file storage
 */

const db = require('../db-v3');
const logger = require('../logger');
const auditService = require('./audit');
const path = require('path');
const fs = require('fs/promises');

class FilesService {
  constructor() {
    this.storageRoot = path.resolve(process.env.FILES_STORAGE_PATH || path.join(process.cwd(), 'data', 'uploads-v3'));
  }

  async logAuditSafe(action, entityType, entityId, oldValue, newValue) {
    try {
      if (typeof auditService.log === 'function') {
        await auditService.log(action, entityType, entityId, oldValue, newValue);
        return;
      }
      if (typeof auditService.logAudit === 'function') {
        await auditService.logAudit(null, action, entityType, entityId, null, newValue);
      }
    } catch (err) {
      logger.warn(`Audit logging skipped: ${err.message}`);
    }
  }

  /**
   * Upload file
   */
  async uploadFile(fileData, metadata, userId) {
    const { filename, mimeType, size, buffer } = fileData;
    const { entityType, entityId, category, description } = metadata;
    
    // Generate unique filename
    const uniqueFilename = `${Date.now()}-${filename}`;
    
    // Store file metadata in DB
    const query = `
      INSERT INTO files (
        entity_type, entity_id, filename, original_name, mime_type,
        size, category, description, uploaded_by, storage_path
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *;
    `;
    
    const result = await db.query(query, [
      entityType,
      entityId,
      uniqueFilename,
      filename,
      mimeType,
      size,
      category || 'document',
      description || null,
      userId,
      `uploads/${entityType}/${entityId}/${uniqueFilename}`,
    ]);
    
    const file = result.rows[0];
    
    await this.saveToStorage(buffer, file.storage_path);
    
    await this.logAuditSafe('FILE_UPLOADED', 'files', file.id, null, file);
    
    logger.info(`File uploaded: ${file.id} (${filename})`);
    
    return file;
  }
  
  /**
   * Get file metadata
   */
  async getFile(fileId) {
    const query = 'SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL';
    const result = await db.query(query, [fileId]);
    
    return result.rows[0];
  }
  
  /**
   * List files for entity
   */
  async listFiles(entityType, entityId, category = null) {
    let query = `
      SELECT * FROM files
      WHERE entity_type = $1 AND entity_id = $2 AND deleted_at IS NULL
    `;
    const params = [entityType, entityId];
    
    if (category) {
      query += ' AND category = $3';
      params.push(category);
    }
    
    query += ' ORDER BY created_at DESC';
    
    const result = await db.query(query, params);
    return result.rows;
  }
  
  /**
   * Download file
   */
  async downloadFile(fileId) {
    const file = await this.getFile(fileId);
    
    if (!file) {
      throw new Error('File not found');
    }
    
    const buffer = await this.getFromStorage(file.storage_path);
    
    await this.logAuditSafe('FILE_DOWNLOADED', 'files', fileId, null, { downloaded_by: fileId });
    
    logger.info(`File downloaded: ${fileId}`);
    
    return {
      filename: file.original_name,
      mimeType: file.mime_type,
      buffer,
    };
  }
  
  /**
   * Delete file (soft delete)
   */
  async deleteFile(fileId, userId) {
    const query = `
      UPDATE files
      SET deleted_at = NOW(), deleted_by = $1
      WHERE id = $2 AND deleted_at IS NULL
      RETURNING *;
    `;
    
    const result = await db.query(query, [userId, fileId]);
    
    if (result.rows.length === 0) {
      throw new Error('File not found');
    }
    
    const file = result.rows[0];
    
    await this.deleteFromStorage(file.storage_path);
    
    await this.logAuditSafe('FILE_DELETED', 'files', fileId, null, file);
    
    logger.info(`File deleted: ${fileId}`);
    
    return file;
  }
  
  /**
   * Save file to storage
   * @private
   */
  async saveToStorage(buffer, path) {
    const relativePath = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relativePath) throw new Error('Invalid storage path');
    const absolutePath = this.resolveStoragePath(relativePath);
    await fs.mkdir(require('path').dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, buffer);
    return absolutePath;
  }
  
  /**
   * Get file from storage
   * @private
   */
  async getFromStorage(path) {
    const relativePath = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relativePath) throw new Error('Invalid storage path');
    const absolutePath = this.resolveStoragePath(relativePath);
    return fs.readFile(absolutePath);
  }
  
  /**
   * Delete file from storage
   * @private
   */
  async deleteFromStorage(path) {
    const relativePath = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relativePath) throw new Error('Invalid storage path');
    const absolutePath = this.resolveStoragePath(relativePath);
    try {
      await fs.unlink(absolutePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  resolveStoragePath(relativeStoragePath) {
    const normalized = relativeStoragePath.replace(/\.\.(\/|\\)/g, '');
    const absolute = path.resolve(this.storageRoot, normalized);
    const rootWithSep = this.storageRoot.endsWith(path.sep) ? this.storageRoot : this.storageRoot + path.sep;
    if (!absolute.startsWith(rootWithSep) && absolute !== this.storageRoot) {
      throw new Error('Invalid storage path traversal');
    }
    return absolute;
  }
}

module.exports = new FilesService();
