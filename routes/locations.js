import express from 'express';
import { pool } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { getSubscriptionDetails } from '../services/stripe.js';

const router = express.Router();

/** Check if user has multi_location_enabled (DB first, fallback to Stripe metadata) */
async function hasMultiLocation(userId) {
  try {
    const r = await pool.query(
      'SELECT multi_location_enabled, stripe_subscription_id FROM users WHERE id = $1',
      [userId]
    );
    if (!r.rows[0]) return false;
    if (r.rows[0].multi_location_enabled === true) return true;
    const sub = await getSubscriptionDetails(userId);
    if (!sub || sub.metadata?.multiLocation !== '1') return false;
    await pool.query('UPDATE users SET multi_location_enabled = TRUE WHERE id = $1', [userId]);
    return true;
  } catch (e) {
    if (e.code === '42703' || String(e.message || '').includes('multi_location_enabled')) {
      return false;
    }
    throw e;
  }
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const hasMulti = await hasMultiLocation(req.userId);
    if (!hasMulti) {
      return res.status(403).json({
        error: 'Multi-location is not enabled for your plan. Upgrade to add multiple locations.',
      });
    }
    const result = await pool.query(
      `SELECT id, name, latitude, longitude, radius, sort_order, created_at 
       FROM locations 
       WHERE user_id = $1 
       ORDER BY sort_order ASC, name ASC`,
      [req.userId]
    );
    res.json({ locations: result.rows });
  } catch (error) {
    console.error('Get locations error:', error);
    res.status(500).json({ error: 'Failed to get locations' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const hasMulti = await hasMultiLocation(req.userId);
    if (!hasMulti) {
      return res.status(403).json({
        error: 'Multi-location is not enabled for your plan. Upgrade to add multiple locations.',
      });
    }
    const { name, latitude, longitude, radius } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Location name is required' });
    }
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (Number.isNaN(lat) || lat < -90 || lat > 90) {
      return res.status(400).json({ error: 'Invalid latitude. Must be between -90 and 90' });
    }
    if (Number.isNaN(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid longitude. Must be between -180 and 180' });
    }
    const rad = radius != null ? parseInt(radius, 10) : 100;
    if (Number.isNaN(rad) || rad < 10 || rad > 10000) {
      return res.status(400).json({ error: 'Invalid radius. Must be between 10 and 10000 meters' });
    }
    const result = await pool.query(
      `INSERT INTO locations (user_id, name, latitude, longitude, radius, sort_order)
       VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT MAX(sort_order) FROM locations WHERE user_id = $1), 0) + 1)
       RETURNING id, name, latitude, longitude, radius, sort_order, created_at`,
      [req.userId, name.trim(), lat, lng, rad]
    );
    res.status(201).json({ location: result.rows[0] });
  } catch (error) {
    console.error('Create location error:', error);
    res.status(500).json({ error: 'Failed to create location' });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const hasMulti = await hasMultiLocation(req.userId);
    if (!hasMulti) {
      return res.status(403).json({ error: 'Multi-location is not enabled for your plan.' });
    }
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid location ID' });
    }
    const { name, latitude, longitude, radius } = req.body;
    const updates = [];
    const values = [];
    let i = 1;
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Location name cannot be empty' });
      }
      updates.push(`name = $${i++}`);
      values.push(name.trim());
    }
    if (latitude !== undefined && longitude !== undefined) {
      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);
      if (Number.isNaN(lat) || lat < -90 || lat > 90) {
        return res.status(400).json({ error: 'Invalid latitude' });
      }
      if (Number.isNaN(lng) || lng < -180 || lng > 180) {
        return res.status(400).json({ error: 'Invalid longitude' });
      }
      updates.push(`latitude = $${i++}`, `longitude = $${i++}`);
      values.push(lat, lng);
    }
    if (radius !== undefined) {
      const rad = parseInt(radius, 10);
      if (Number.isNaN(rad) || rad < 10 || rad > 10000) {
        return res
          .status(400)
          .json({ error: 'Invalid radius. Must be between 10 and 10000 meters' });
      }
      updates.push(`radius = $${i++}`);
      values.push(rad);
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    values.push(id, req.userId);
    const result = await pool.query(
      `UPDATE locations 
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${i} AND user_id = $${i + 1}
       RETURNING id, name, latitude, longitude, radius, sort_order, created_at, updated_at`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }
    res.json({ location: result.rows[0] });
  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const hasMulti = await hasMultiLocation(req.userId);
    if (!hasMulti) {
      return res.status(403).json({ error: 'Multi-location is not enabled for your plan.' });
    }
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid location ID' });
    }
    const result = await pool.query(
      'DELETE FROM locations WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }
    res.json({ message: 'Location deleted successfully' });
  } catch (error) {
    console.error('Delete location error:', error);
    res.status(500).json({ error: 'Failed to delete location' });
  }
});

export default router;
