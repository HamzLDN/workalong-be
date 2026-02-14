import express from 'express';
import { getActivities, getActivityStats } from '../activity.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    const activities = await getActivities(req.userId, limit, offset);
    res.json({ activities });
  } catch (error) {
    console.error('Get activities error:', error);
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const stats = await getActivityStats(req.userId);
    res.json({ stats });
  } catch (error) {
    console.error('Get activity stats error:', error);
    res.status(500).json({ error: 'Failed to fetch activity stats' });
  }
});

export default router;
