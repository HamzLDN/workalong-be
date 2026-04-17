import { Router } from 'express';
import { getTrialPeriodDays } from '../lib/appSettings.js';

const router = Router();

/** Public: trial length for marketing site / plans page (no auth). */
router.get('/trial-period', async (_req, res) => {
  try {
    const trialPeriodDays = await getTrialPeriodDays();
    res.json({ trialPeriodDays });
  } catch (e) {
    console.error('GET /public/trial-period:', e);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

export default router;
