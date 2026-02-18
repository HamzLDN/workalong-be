import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireSubscription } from '../middleware/obfuscation.js';

const router = express.Router();

// All fraud endpoints require subscription
router.use(requireAuth);
router.use(requireSubscription);

router.post('/analyze/:staffId', async (req, res) => {
  try {
    const { analyzeFraudPatterns, createFraudFlag } = await import('../lib/fraud-detection.js');
    const { staffId } = req.params;
    const { days = 30 } = req.body;
    const flags = await analyzeFraudPatterns(req.userId, parseInt(staffId), days);
    const created = [];
    for (const flag of flags) {
      const f = await createFraudFlag(req.userId, parseInt(staffId), flag);
      if (f) created.push(f);
    }
    res.json({ flags: created, analyzed: flags });
  } catch (error) {
    console.error('Analyze fraud error:', error);
    res.status(500).json({ error: 'Failed to analyze patterns' });
  }
});

router.post('/analyze-all', async (req, res) => {
  try {
    const { analyzeAllStaff } = await import('../lib/fraud-detection.js');
    const flags = await analyzeAllStaff(req.userId);
    res.json({ message: 'Analysis complete', flagsCreated: flags.length, flags });
  } catch (error) {
    console.error('Analyze all staff error:', error);
    res.status(500).json({ error: 'Failed to analyze all staff' });
  }
});

router.get('/flags', async (req, res) => {
  try {
    const { getFraudFlags } = await import('../lib/fraud-detection.js');
    const { staffId, includeResolved } = req.query;
    const flags = await getFraudFlags(
      req.userId,
      staffId ? parseInt(staffId) : null,
      includeResolved === 'true'
    );
    res.json({ flags });
  } catch (error) {
    console.error('Get fraud flags error:', error);
    res.status(500).json({ error: 'Failed to get fraud flags' });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const { getFraudStats } = await import('../lib/fraud-detection.js');
    const stats = await getFraudStats(req.userId);
    res.json(stats);
  } catch (error) {
    console.error('Get fraud stats error:', error);
    res.status(500).json({ error: 'Failed to get fraud stats' });
  }
});

router.put('/flags/:id/resolve', async (req, res) => {
  try {
    const { resolveFraudFlag } = await import('../lib/fraud-detection.js');
    const { id } = req.params;
    const { notes } = req.body;
    const flag = await resolveFraudFlag(parseInt(id), req.userId, notes);
    res.json({ message: 'Flag resolved', flag });
  } catch (error) {
    console.error('Resolve fraud flag error:', error);
    res.status(500).json({ error: 'Failed to resolve flag' });
  }
});

export default router;
