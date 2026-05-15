import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  user: config.db.user,
  password: config.db.password,
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
});

// Test connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
  process.exit(-1);
});

/**
 * Blocks until PostgreSQL accepts a simple query. Use before binding HTTP so clients do not hit 500s
 * while Postgres is still starting (e.g. docker compose restart).
 */
export async function waitForDatabaseReady(options = {}) {
  const maxAttempts = Number(options.maxAttempts) || 60;
  const delayMs = Number(options.delayMs) || 1000;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query('SELECT 1');
      if (attempt > 1) {
        console.log(`[db] PostgreSQL ready after ${attempt} attempts`);
      }
      return;
    } catch (err) {
      lastErr = err;
      const code = err?.code;
      const msg = String(err?.message || '');
      const transient =
        code === 'ECONNREFUSED' ||
        code === 'ETIMEDOUT' ||
        code === 'ENOTFOUND' ||
        code === 'ECONNRESET' ||
        code === '57P03' ||
        code === '57P01' ||
        /not yet accepting connections|the database system is starting up|Connection terminated unexpectedly/i.test(
          msg
        );
      if (!transient && attempt < maxAttempts) {
        throw err;
      }
      console.warn(`[db] Waiting for PostgreSQL (${attempt}/${maxAttempts}): ${err.message}`);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr ?? new Error('PostgreSQL not ready');
}

export default pool;
