import express from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './lib/swagger.js';
import { config } from './lib/config.js';
import { pool } from './lib/db.js';
import { cleanupExpiredSessions } from './services/auth.js';
import { runBillingReminders } from './services/billing-reminders.js';
import {
  requestFingerprinting,
  detectSessionTokenMisuse,
  securityHeaders,
  createRateLimiter,
} from './middleware/security.js';
import { verifyObfuscatedRequest, obfuscateResponse } from './middleware/obfuscation.js';
import { registerRoutes } from './routes/index.js';
import { createProxyMiddleware } from 'http-proxy-middleware';

const app = express();

/**
 * Forward support chat + Socket.IO to admin-panel-api.
 * - Dev: default target http://127.0.0.1:5055 (unless ADMIN_PANEL_PROXY=false).
 * - Prod Docker: set ADMIN_PANEL_API_URL=http://admin-panel-api:5055 so nginx can send all /api to
 *   this backend and we still reach the admin service (avoids relying on nginx splitting /api/support).
 */
const adminPanelTarget =
  process.env.ADMIN_PANEL_API_URL || process.env.SUPPORT_CHAT_UPSTREAM || 'http://127.0.0.1:5055';
const useAdminPanelProxy =
  process.env.ADMIN_PANEL_PROXY !== 'false' &&
  (process.env.NODE_ENV === 'dev' ||
    process.env.ADMIN_PANEL_API_URL ||
    process.env.SUPPORT_CHAT_UPSTREAM);

let adminSocketIoProxy = null;
if (useAdminPanelProxy) {
  adminSocketIoProxy = createProxyMiddleware({
    target: adminPanelTarget,
    changeOrigin: true,
    ws: true,
  });
  app.use(
    '/api/support',
    createProxyMiddleware({
      target: adminPanelTarget,
      changeOrigin: true,
    })
  );
  app.use('/socket.io', adminSocketIoProxy);
  if (process.env.NODE_ENV === 'production' || process.env.DOCKER === 'true') {
    console.log(`[proxy] Admin panel API: ${adminPanelTarget} (/api/support, /socket.io)`);
  }
}
let httpsServer = null;
let shuttingDown = false;
let cleanupInterval = null;

const allowedOrigins = [
  'http://localhost',
  'https://localhost',
  'http://localhost:3000',
  'https://localhost:3000',
  'http://localhost:3001',
  'https://localhost:3001',
  'http://localhost:3443',
  'https://localhost:3443',
  'https://workalong.co.uk',
  'https://www.workalong.co.uk',
  'http://workalong.co.uk',
  'http://www.workalong.co.uk',
  'https://api.workalong.co.uk',
  'http://api.workalong.co.uk',
];

if (process.env.DOCKER === 'true' || process.env.NODE_ENV === 'production') {
  allowedOrigins.push('http://frontend');
  allowedOrigins.push('https://frontend');
}

const isProduction = process.env.NODE_ENV === 'production';
const isDocker = process.env.DOCKER === 'true';

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);

      if (!isDocker && !isProduction) {
        console.log(`CORS: Allowing all origins in dev mode: ${origin}`);
        callback(null, true);
        return;
      }

      if (isDocker || isProduction) {
        if (origin.match(/^https?:\/\/(172\.|10\.|192\.168\.)/)) {
          callback(null, true);
          return;
        }
        if (origin.includes('frontend')) {
          callback(null, true);
          return;
        }
      }

      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
        return;
      }

      const adminOrigins = (process.env.ADMIN_PANEL_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (adminOrigins.length && adminOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
app.use(express.json({ type: ['application/json', 'application/x-obfuscated'] }));
app.use(cookieParser());

app.set('trust proxy', 1);

app.use(securityHeaders);
app.use(requestFingerprinting);
app.use(detectSessionTokenMisuse);
app.use('/api', createRateLimiter({ limitPerMinute: 100, limitPerHour: 5000 }));
app.use(verifyObfuscatedRequest);
app.use(obfuscateResponse);

app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'WorkAlong API Documentation',
  })
);

cleanupInterval = setInterval(cleanupExpiredSessions, 60 * 60 * 1000);
cleanupInterval.unref?.();

// Run billing reminders once at startup (catches any missed from overnight) then every 24 hours
runBillingReminders();
const billingReminderInterval = setInterval(runBillingReminders, 24 * 60 * 60 * 1000);
billingReminderInterval.unref?.();

registerRoutes(app);

const HTTP_PORT = config.port || 3001;
const HTTPS_PORT = 443;

const httpServer = http.createServer(app);

function attachAdminPanelSocketUpgrade(server) {
  if (!adminSocketIoProxy || !server) return;
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/socket.io')) {
      adminSocketIoProxy.upgrade(req, socket, head);
    }
  });
}

attachAdminPanelSocketUpgrade(httpServer);

function handleListenError(name, port) {
  return (err) => {
    if (err.code === 'EACCES') {
      console.log(`??  Cannot bind ${name} server to port ${port} (requires elevated privileges)`);
    } else if (err.code === 'EADDRINUSE') {
      console.log(`??  Port ${port} is already in use for ${name}`);
      console.log('??  Another backend process is likely still running.');
    } else {
      console.error(`? ${name} server error:`, err.message);
    }

    if (!shuttingDown) {
      shutdown(`${name}_STARTUP_ERROR`, 1);
    }
  };
}

httpServer
  .listen(HTTP_PORT, () => {
    console.log(`?? HTTP Server running on http://localhost:${HTTP_PORT}`);
    console.log(`?? API available at http://localhost:${HTTP_PORT}/api`);
  })
  .on('error', handleListenError('HTTP', HTTP_PORT));

let httpsOptions = null;
const LETSENCRYPT_KEY = '/etc/letsencrypt/live/workalong.co.uk/privkey.pem';
const LETSENCRYPT_CERT = '/etc/letsencrypt/live/workalong.co.uk/fullchain.pem';
const DOCKER_SSL_KEY = '/etc/nginx/ssl/privkey.pem';
const DOCKER_SSL_CERT = '/etc/nginx/ssl/fullchain.pem';
const DEV_KEY = './certs/key.pem';
const DEV_CERT = './certs/cert.pem';

try {
  if (fs.existsSync(LETSENCRYPT_KEY) && fs.existsSync(LETSENCRYPT_CERT)) {
    httpsOptions = {
      key: fs.readFileSync(LETSENCRYPT_KEY),
      cert: fs.readFileSync(LETSENCRYPT_CERT),
    };
    console.log("Using Let's Encrypt certificates for workalong.co.uk");
  } else if (fs.existsSync(DOCKER_SSL_KEY) && fs.existsSync(DOCKER_SSL_CERT)) {
    httpsOptions = {
      key: fs.readFileSync(DOCKER_SSL_KEY),
      cert: fs.readFileSync(DOCKER_SSL_CERT),
    };
    console.log('Using Docker-mounted SSL certificates');
  } else if (fs.existsSync(DEV_KEY) && fs.existsSync(DEV_CERT)) {
    httpsOptions = {
      key: fs.readFileSync(DEV_KEY),
      cert: fs.readFileSync(DEV_CERT),
    };
    console.log('Using development SSL certificates');
  } else {
    throw new Error('No SSL certificates found');
  }

  httpsServer = https.createServer(httpsOptions, app);
  attachAdminPanelSocketUpgrade(httpsServer);

  const HTTPS_DEV_PORT =
    process.env.NODE_ENV === 'production' || process.env.DOCKER === 'true' ? HTTPS_PORT : 3443;
  const DOMAIN = process.env.NODE_ENV === 'production' ? 'workalong.co.uk' : 'localhost';

  httpsServer
    .listen(HTTPS_DEV_PORT, () => {
      if (HTTPS_DEV_PORT === 443) {
        console.log(`?? HTTPS Server running on https://${DOMAIN}`);
        console.log(`?? Secure API available at https://${DOMAIN}/api`);
      } else {
        console.log(`?? HTTPS Server running on https://${DOMAIN}:${HTTPS_DEV_PORT}`);
        console.log(`?? Secure API available at https://${DOMAIN}:${HTTPS_DEV_PORT}/api`);
        console.log(`??  Using port ${HTTPS_DEV_PORT} for development. Use sudo for port 443.`);
      }
    })
    .on('error', handleListenError('HTTPS', HTTPS_DEV_PORT, true));
} catch (err) {
  console.log('??  HTTPS certificates not found. Running HTTP only.');
  console.log(
    '?? For production: sudo certbot certonly --standalone -d workalong.co.uk -d www.workalong.co.uk'
  );
  console.log('?? For development: cd workalong-backend && ./docker/scripts/generate-cert.sh');
}

async function shutdown(signal, exitCode = 0, { skipExit = false } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}. Shutting down servers...`);

  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  const closeServer = (server, name) =>
    new Promise((resolve) => {
      if (!server || !server.listening) return resolve();
      server.close((err) => {
        if (err) console.error(`${name} close error:`, err.message || err);
        resolve();
      });
    });

  try {
    await Promise.all([closeServer(httpServer, 'HTTP'), closeServer(httpsServer, 'HTTPS')]);
  } catch (err) {
    console.error('Server shutdown error:', err.message || err);
  }

  try {
    await pool.end();
  } catch (err) {
    console.error('DB pool shutdown error:', err.message || err);
  }

  if (!skipExit) {
    process.exit(exitCode);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGUSR2', async () => {
  await shutdown('SIGUSR2', 0, { skipExit: true });
  process.kill(process.pid, 'SIGUSR2');
});
