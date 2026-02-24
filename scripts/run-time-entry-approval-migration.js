/**
 * Migration: Add approved_at and approved_by to time_entries for per-entry approval.
 * Run with: npm run migrate:time-entry-approval
 * Works with Docker mock DB - ensure backend .env points to your Postgres (e.g. port 5433 for mock).
 */
import { pool } from '../lib/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  try {
    console.log('Running migration: Add time_entries approved_at/approved_by...');

    const sqlPath = path.join(__dirname, '../database-schema/add-time-entry-approval.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    await pool.query(sql);

    console.log('✅ Migration completed successfully!');
    console.log('The approved_at and approved_by columns have been added to time_entries.');

    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'time_entries' AND column_name IN ('approved_at', 'approved_by')
    `);
    if (result.rows.length >= 2) {
      console.log('✅ Verification: Columns exist');
    }
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

runMigration();
