import express from 'express';
import {
  createApiKey,
  getUserApiKeys,
  revokeApiKey,
  deleteApiKey,
  addIpToWhitelist,
  removeIpFromWhitelist,
  getUserWhitelistedIps,
  logSecurityEvent,
  getSecurityAuditLogs,
} from '../lib/api-security.js';
import { createRateLimiter } from '../middleware/security.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.post(
  '/api-keys',
  requireAuth,
  createRateLimiter({ limitPerMinute: 5 }),
  async (req, res) => {
    try {
      const {
        keyName,
        expiresAt,
        allowedIps,
        allowedEndpoints,
        rateLimitPerMinute,
        rateLimitPerHour,
      } = req.body;
      if (!keyName) {
        return res.status(400).json({ error: 'Key name is required' });
      }
      const result = await createApiKey(req.userId, keyName, {
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        allowedIps: allowedIps || [],
        allowedEndpoints: allowedEndpoints || [],
        rateLimitPerMinute: rateLimitPerMinute || 60,
        rateLimitPerHour: rateLimitPerHour || 1000,
      });
      await logSecurityEvent('api_key_created', {
        userId: req.userId,
        ipAddress: req.ip,
        endpoint: req.path,
        requestMethod: req.method,
        details: { keyName, prefix: result.api_key_prefix },
        severity: 'info',
      });
      res.status(201).json({
        message: 'API key created successfully',
        apiKey: result.apiKey,
        key: {
          id: result.id,
          keyName: result.key_name,
          prefix: result.api_key_prefix,
          expiresAt: result.expires_at,
          allowedIps: result.allowed_ips,
          allowedEndpoints: result.allowed_endpoints,
          rateLimitPerMinute: result.rate_limit_per_minute,
          rateLimitPerHour: result.rate_limit_per_hour,
          createdAt: result.created_at,
        },
      });
    } catch (error) {
      console.error('Create API key error:', error);
      if (error.constraint === 'unique_user_key_name') {
        return res.status(400).json({ error: 'API key with this name already exists' });
      }
      res.status(500).json({ error: 'Failed to create API key' });
    }
  }
);

router.get('/api-keys', requireAuth, async (req, res) => {
  try {
    const keys = await getUserApiKeys(req.userId);
    res.json({ keys });
  } catch (error) {
    console.error('List API keys error:', error);
    res.status(500).json({ error: 'Failed to retrieve API keys' });
  }
});

router.post('/api-keys/:keyId/revoke', requireAuth, async (req, res) => {
  try {
    const { keyId } = req.params;
    const revoked = await revokeApiKey(req.userId, keyId);
    if (!revoked) {
      return res.status(404).json({ error: 'API key not found' });
    }
    await logSecurityEvent('api_key_revoked', {
      userId: req.userId,
      ipAddress: req.ip,
      endpoint: req.path,
      requestMethod: req.method,
      details: { keyId },
      severity: 'info',
    });
    res.json({ message: 'API key revoked successfully' });
  } catch (error) {
    console.error('Revoke API key error:', error);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

router.delete('/api-keys/:keyId', requireAuth, async (req, res) => {
  try {
    const { keyId } = req.params;
    const deleted = await deleteApiKey(req.userId, keyId);
    if (!deleted) {
      return res.status(404).json({ error: 'API key not found' });
    }
    await logSecurityEvent('api_key_deleted', {
      userId: req.userId,
      ipAddress: req.ip,
      endpoint: req.path,
      requestMethod: req.method,
      details: { keyId },
      severity: 'info',
    });
    res.json({ message: 'API key deleted successfully' });
  } catch (error) {
    console.error('Delete API key error:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

router.post('/ip-whitelist', requireAuth, async (req, res) => {
  try {
    const { ipAddress, description } = req.body;
    if (!ipAddress) {
      return res.status(400).json({ error: 'IP address is required' });
    }
    const result = await addIpToWhitelist(req.userId, ipAddress, description);
    await logSecurityEvent('ip_whitelisted', {
      userId: req.userId,
      ipAddress: req.ip,
      endpoint: req.path,
      requestMethod: req.method,
      details: { whitelistedIp: ipAddress },
      severity: 'info',
    });
    res.status(201).json({ message: 'IP address added to whitelist', ip: result });
  } catch (error) {
    console.error('Add IP whitelist error:', error);
    res.status(500).json({ error: 'Failed to add IP to whitelist' });
  }
});

router.delete('/ip-whitelist/:ipAddress', requireAuth, async (req, res) => {
  try {
    const { ipAddress } = req.params;
    const removed = await removeIpFromWhitelist(req.userId, decodeURIComponent(ipAddress));
    if (!removed) {
      return res.status(404).json({ error: 'IP address not found in whitelist' });
    }
    res.json({ message: 'IP address removed from whitelist' });
  } catch (error) {
    console.error('Remove IP whitelist error:', error);
    res.status(500).json({ error: 'Failed to remove IP from whitelist' });
  }
});

router.get('/ip-whitelist', requireAuth, async (req, res) => {
  try {
    const ips = await getUserWhitelistedIps(req.userId);
    res.json({ ips });
  } catch (error) {
    console.error('List IP whitelist error:', error);
    res.status(500).json({ error: 'Failed to retrieve whitelisted IPs' });
  }
});

router.get('/audit-logs', requireAuth, async (req, res) => {
  try {
    // Audit logs are admin-only - check if user is admin
    const { pool } = await import('../lib/db.js');

    // Check if is_admin column exists, if not deny access
    let isAdmin = false;
    try {
      const userResult = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);

      if (userResult.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
      }

      isAdmin = userResult.rows[0].is_admin === true;
    } catch (columnError) {
      // Column doesn't exist - deny access
      if (columnError.code === '42703') {
        console.log('is_admin column does not exist - denying access to audit logs');
        return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
      }
      throw columnError;
    }

    if (!isAdmin) {
      return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
    }

    const limit = parseInt(req.query.limit) || 100;
    // Admins can see all logs (no userId filter)
    const logs = await getSecurityAuditLogs(null, limit);
    res.json({ logs });
  } catch (error) {
    console.error('Get audit logs error:', error);
    res.status(500).json({ error: 'Failed to retrieve audit logs' });
  }
});

export default router;
