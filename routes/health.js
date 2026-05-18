import express from 'express';

const router = express.Router();

router.get('/', (req, res) => {
  const devPlainObfuscation =
    process.env.NODE_ENV === 'dev' && process.env.DISABLE_OBFUSCATION === 'true';
  res.json({
    status: 'ok',
    message: 'Server is running',
    security: {
      devPlainObfuscation,
      devSubscriptionBypass: process.env.NODE_ENV === 'dev',
    },
  });
});

export default router;
