/**
 * Additively sync the configured DB schema to match `database-schema/`.
 *
 * The target database is controlled only by DB_* environment variables.
 * This is intentionally non-destructive:
 * - creates missing tables/sequences/indexes/constraints
 * - applies additive migrations for newer columns/tables
 * - does not drop tables/columns or wipe data
 */
import { pool } from '../lib/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEMA_DIR = path.join(__dirname, '..', 'database-schema');

const BASE_SCHEMA_FILES = [
  'users.sql',
  'sessions.sql',
  'password_reset_tokens.sql',
  'login_codes.sql',
  'api_keys.sql',
  'ip_whitelists.sql',
  'request_signing_keys.sql',
  'staff.sql',
  'staff_sessions.sql',
  'staff_password_tokens.sql',
  'payroll_records.sql',
  'payroll_line_items.sql',
  'budgets.sql',
  'shifts.sql',
  'time_entries.sql',
  'shift_swap_requests.sql',
  'shift_swaps.sql',
  'activity_feed.sql',
  'fraud_flags.sql',
  'security_audit_logs.sql',
  'rate_limit_logs.sql',
  'device_links.sql',
];

const ADDITIVE_MIGRATIONS = [
  {
    name: 'subscription_discount_percent',
    file: 'add-discount-percent-column.sql',
    dir: __dirname,
  },
  {
    name: 'sessions csrf_token',
    file: 'add-session-csrf-token.sql',
    dir: SCHEMA_DIR,
  },
  {
    name: 'time_entries approved_at/approved_by',
    file: 'add-time-entry-approval.sql',
    dir: SCHEMA_DIR,
  },
  {
    name: 'users timezone + time_entries leave_category',
    file: 'add-leave-category-and-timezone.sql',
    dir: SCHEMA_DIR,
  },
  {
    name: 'staff_face_profiles (Face ID kiosk)',
    file: 'add-staff-face-profiles.sql',
    dir: SCHEMA_DIR,
  },
  {
    name: 'staff.lastname (full name on kiosk)',
    file: 'add_staff_lastname.sql',
    dir: SCHEMA_DIR,
  },
  {
    name: 'staff_face_profiles.face_embeddings (Face API descriptors)',
    file: 'add-face-embeddings-column.sql',
    dir: SCHEMA_DIR,
  },
  {
    name: 'payroll hub (sick_leave + pension/leave prefs on users)',
    file: 'add-payroll-hub-extension.sql',
    dir: SCHEMA_DIR,
  },
  {
    name: 'company structure (branches, departments, staff assignments)',
    file: 'add-company-structure.sql',
    dir: SCHEMA_DIR,
  },
];

function splitSqlStatements(sql) {
  const statements = [];
  let buffer = [];

  for (const line of sql.split(/\r?\n/)) {
    buffer.push(line);
    if (line.trim().endsWith(';')) {
      const statement = buffer.join('\n').trim();
      if (statement) statements.push(statement);
      buffer = [];
    }
  }

  const tail = buffer.join('\n').trim();
  if (tail) statements.push(tail);
  return statements;
}

function isIgnorableSchemaError(err) {
  return (
    err?.message?.includes('already exists') ||
    err?.code === '42701' || // duplicate_column
    err?.code === '42P07' || // duplicate_table / relation already exists
    err?.code === '42710' || // duplicate_object
    err?.code === '42723' || // duplicate_function
    err?.code === '42P16' // invalid_table_definition (e.g. second PK)
  );
}

function isRetryableDependencyError(err) {
  return (
    err?.code === '42P01' || // undefined_table
    err?.code === '42703' // undefined_column
  );
}

async function applyStatementBatch(name, sql, { allowRetryableDependencies = false } = {}) {
  let deferred = false;

  for (const statement of splitSqlStatements(sql)) {
    try {
      await pool.query(statement);
    } catch (err) {
      if (isIgnorableSchemaError(err)) continue;
      if (allowRetryableDependencies && isRetryableDependencyError(err)) {
        deferred = true;
        continue;
      }
      throw new Error(`${name} failed (${err.code || 'no-code'}): ${err.message}`);
    }
  }

  return deferred;
}

async function applyFunctionsFile() {
  const file = path.join(SCHEMA_DIR, '00_functions_and_triggers.sql');
  if (!fs.existsSync(file)) return;

  const sql = fs
    .readFileSync(file, 'utf8')
    .replace(/^CREATE FUNCTION /gm, 'CREATE OR REPLACE FUNCTION ');

  console.log('📦 Syncing shared functions...');
  await pool.query(sql);
  console.log('✅ Shared functions synced');
}

async function syncBaseSchema() {
  const maxPasses = 3;

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    let deferredCount = 0;
    console.log(`\n📚 Base schema sync pass ${pass}/${maxPasses}`);

    for (const file of BASE_SCHEMA_FILES) {
      const sqlPath = path.join(SCHEMA_DIR, file);
      if (!fs.existsSync(sqlPath)) {
        console.log(`⏭️  Skipping missing schema file: ${file}`);
        continue;
      }

      const sql = fs.readFileSync(sqlPath, 'utf8');
      const deferred = await applyStatementBatch(file, sql, {
        allowRetryableDependencies: true,
      });

      if (deferred) deferredCount += 1;
      console.log(`${deferred ? '↻' : '✅'} ${file}`);
    }

    if (deferredCount === 0) return;
  }

  throw new Error(
    'Base schema sync still has unresolved table/column dependencies after 3 passes.'
  );
}

async function runAdditiveMigrations() {
  for (const migration of ADDITIVE_MIGRATIONS) {
    const sqlPath = path.join(migration.dir, migration.file);
    if (!fs.existsSync(sqlPath)) {
      console.log(`⏭️  Skipping ${migration.name} (file not found: ${migration.file})`);
      continue;
    }

    console.log(`📦 Applying ${migration.name}...`);
    const sql = fs.readFileSync(sqlPath, 'utf8');
    try {
      await pool.query(sql);
    } catch (err) {
      if (isIgnorableSchemaError(err)) {
        console.log(`⏭️  ${migration.name} already applied (${err.code || 'n/a'})`);
        continue;
      }
      throw new Error(`${migration.name} failed (${err.code || 'no-code'}): ${err.message}`);
    }
    console.log(`✅ ${migration.name}`);
  }
}

async function syncSchema() {
  if (!process.env.DB_PORT) {
    console.error(
      '❌  DB_PORT is not set.\n' +
      '    To sync the mock DB run:  npm run db:mock:sync\n' +
      '    For production, set DB_PORT explicitly before running this script.'
    );
    process.exit(1);
  }

  const dbHost = process.env.DB_HOST || 'localhost';
  const isLocal = ['localhost', '127.0.0.1', '0.0.0.0'].includes(dbHost);

  console.log('Syncing schema against database:');
  console.log(`  DB_HOST=${dbHost}`);
  console.log(`  DB_PORT=${process.env.DB_PORT}`);
  console.log(`  DB_NAME=${process.env.DB_NAME || 'users'}`);
  if (!isLocal) {
    console.log('\n⚠️  Target is not localhost - ensure this is intended for production.');
  }
  console.log('');

  await applyFunctionsFile();
  await syncBaseSchema();
  await runAdditiveMigrations();

  console.log('\n✅ Schema sync completed.');
  await pool.end();
  process.exit(0);
}

syncSchema().catch(async (err) => {
  console.error('Fatal schema sync error:', err.message || err);
  await pool.end().catch(() => {});
  process.exit(1);
});
