import express from 'express';

const router = express.Router();

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     description: Returns the health status of the server. Used by Docker health checks and monitoring systems.
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Server is running
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 message:
 *                   type: string
 *                   example: Server is running
 */
router.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

export default router;
