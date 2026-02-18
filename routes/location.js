import express from 'express';
import { pool } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT latitude, longitude, location_radius FROM users WHERE id = $1',
      [req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = result.rows[0];
    res.json({
      latitude: user.latitude,
      longitude: user.longitude,
      radius: user.location_radius || 100
    });
  } catch (error) {
    console.error('Get location error:', error);
    res.status(500).json({ error: 'Failed to get location settings' });
  }
});

router.put('/', requireAuth, async (req, res) => {
  try {
    const { latitude, longitude, radius } = req.body;
    if (latitude !== undefined && latitude !== null) {
      if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) {
        return res.status(400).json({ error: 'Invalid latitude. Must be between -90 and 90' });
      }
    }
    if (longitude !== undefined && longitude !== null) {
      if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) {
        return res.status(400).json({ error: 'Invalid longitude. Must be between -180 and 180' });
      }
    }
    if (radius !== undefined && radius !== null) {
      if (typeof radius !== 'number' || radius < 10 || radius > 10000) {
        return res.status(400).json({ error: 'Invalid radius. Must be between 10 and 10000 meters' });
      }
    }
    const result = await pool.query(
      `UPDATE users SET latitude = $1, longitude = $2, location_radius = $3, updated_at = NOW()
       WHERE id = $4 RETURNING latitude, longitude, location_radius`,
      [latitude, longitude, radius || 100, req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      message: 'Location settings updated successfully',
      latitude: result.rows[0].latitude,
      longitude: result.rows[0].longitude,
      radius: result.rows[0].location_radius
    });
  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({ error: 'Failed to update location settings' });
  }
});

export default router;
