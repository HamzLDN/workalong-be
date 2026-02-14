import express from 'express';

const router = express.Router();
// Health endpoint should not have rate limiting - it's used by Docker health checks
// and should always respond quickly without database dependencies
router.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

export default router;
