/**
 * Run all migrations against the database specified by env vars.
 * Use for production: set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME to prod values.
 *
 * Usage:
 *   DB_HOST=prod.example.com DB_USER=... DB_PASSWORD=... DB_NAME=users NODE_ENV=production node scripts/run-migrations-for-prod.js
 *
 * Or with .env.prod:
 *   set -a && source .env.prod && set +a && NODE_ENV=production node scripts/run-migrations-for-prod.js
 */
import { pool } from '../lib/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS = [
  {
    name: 'subscription_discount_percent',
    file: 'add-discount-percent-column.sql',
    dir: __dirname,
  },
  {
    name: 'time_entries approved_at/approved_by',
    file: 'add-time-entry-approval.sql',
    dir: path.join(__dirname, '..', 'database-schema'),
  },
];

async function runMigrations() {
  const dbHost = process.env.DB_HOST || 'localhost';
  const isLocal = ['localhost', '127.0.0.1', '0.0.0.0'].includes(dbHost);

  console.log('Running migrations against database:');
  console.log(`  DB_HOST=${dbHost}`);
  console.log(`  DB_PORT=${process.env.DB_PORT || 5432}`);
  console.log(`  DB_NAME=${process.env.DB_NAME || 'users'}`);
  if (!isLocal) {
    console.log('\n⚠️  Target is not localhost - ensure this is intended for production.');
  }
  console.log('');

  for (const m of MIGRATIONS) {
    try {
      const sqlPath = path.join(m.dir, m.file);
      if (!fs.existsSync(sqlPath)) {
        console.log(`⏭️  Skipping ${m.name} (file not found: ${m.file})`);
        continue;
      }
      console.log(`📦 Running migration: ${m.name}...`);
      const sql = fs.readFileSync(sqlPath, 'utf8');
      await pool.query(sql);
      console.log(`✅ ${m.name} - done`);
    } catch (err) {
      if (err.message?.includes('already exists') || err.code === '42701') {
        console.log(`⏭️  ${m.name} - already applied`);
      } else {
        console.error(`❌ ${m.name} failed:`, err.message);
        process.exit(1);
      }
    }
  }

  console.log('\n✅ All migrations completed.');
  await pool.end();
  process.exit(0);
}

runMigrations().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
