/**
 * Additively sync the configured DB schema to match `database-schema/`.
 *
 * The target database is controlled only by DB_* environment variables.
 * This is intentionally non-destructive:
 * - creates missing tables/sequences/indexes/constraints
 * - applies additive migrations for newer columns/tables (listed + any `add*.sql` in database-schema/ not in the list)
 * - does not drop tables/columns or wipe data
 */
import { pool } from '../lib/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEMA_DIR = path.join(__dirname, '..', 'database-schema');

// Mock Postgres docker init aggregates these files via `npm run db:mock:init` —
// scripts/generate-mock-init.js `MOCK_INIT_ORDER` mirrors this list (with
// `00_functions_and_triggers.sql` first). Divergence causes docker init to stop on first `\i` error.
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
    name: 'users (discount, timezone, payroll prefs, head_office, manager_permissions)',
    file: 'add-users.sql',
    dir: SCHEMA_DIR,
  },
  {
    name: 'sessions csrf_token',
    file: 'add-session-csrf-token.sql',
    dir: SCHEMA_DIR,
  },
  {
    name: 'time_entries (leave_category, approvals, sick_leave check)',
    file: 'add-time-entries.sql',
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
    name: 'company structure (branches, departments, staff assignments)',
    file: 'add-company-structure.sql',
    dir: SCHEMA_DIR,
  },
  {
    name: 'shifts created_by user/staff',
    file: 'add-shift-creator-columns.sql',
    dir: SCHEMA_DIR,
  },
];

/**
 * Split SQL on top-level ';' boundaries (handles single-quoted strings, line
 * comments, block comments, and dollar-quoted plpgsql/function bodies).
 * Needed so base DDL and pg_dump-derived files execute one statement per
 * pg query — node-postgres SimpleQuery multi-statement payloads are unreliable on some setups.
 */
function splitPgSqlStatements(sql) {
  const stmts = [];
  let buf = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const ch2 = sql[i + 1];

    if (ch === '/' && ch2 === '*') {
      let j = i + 2;
      while (j < n && !(sql[j] === '*' && sql[j + 1] === '/')) j += 1;
      const end = Math.min(j + 2, n);
      buf += sql.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '-' && ch2 === '-') {
      while (i < n && sql[i] !== '\n') {
        buf += sql[i];
        i += 1;
      }
      continue;
    }

    if (ch === "'") {
      buf += "'";
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          buf += "''";
          i += 2;
        } else if (sql[i] === "'") {
          buf += "'";
          i += 1;
          break;
        } else {
          buf += sql[i];
          i += 1;
        }
      }
      continue;
    }

    if (ch === '$') {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_]/.test(sql[j])) j += 1;
      if (j < n && sql[j] === '$') {
        const tag = sql.slice(i + 1, j);
        const delim = `$${tag}$`;
        const closeIdx = sql.indexOf(delim, j + 1);
        if (closeIdx === -1) {
          throw new Error('Unterminated dollar-quoted literal in schema SQL.');
        }
        buf += sql.slice(i, closeIdx + delim.length);
        i = closeIdx + delim.length;
        continue;
      }
    }

    if (ch === ';') {
      buf += ';';
      i += 1;
      const trimmed = buf.trim();
      if (trimmed.length) stmts.push(trimmed);
      buf = '';
      continue;
    }

    buf += ch;
    i += 1;
  }

  const tail = buf.trim();
  if (tail.length) stmts.push(tail);
  return stmts;
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

  for (const statement of splitPgSqlStatements(sql)) {
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
  const statements = splitPgSqlStatements(sql);
  for (const statement of statements) {
    await pool.query(statement);
  }
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

/** Pick up new database-schema/add*.sql migrations without editing ADDITIVE_MIGRATIONS. */
async function applyRemainingSchemaAdditiveSqlFiles() {
  const trackedFromSchemaDir = new Set(
    ADDITIVE_MIGRATIONS.filter((m) => m.dir === SCHEMA_DIR).map((m) => m.file)
  );

  const extras = fs
    .readdirSync(SCHEMA_DIR)
    .filter(
      (name) =>
        name.endsWith('.sql') &&
        name !== 'mock-init.sql' &&
        (name.startsWith('add-') || name.startsWith('add_'))
    )
    .filter((name) => !trackedFromSchemaDir.has(name))
    .sort((a, b) => a.localeCompare(b));

  if (extras.length === 0) return;

  console.log('\n📂 Applying remaining additive SQL files from database-schema/…');

  for (const file of extras) {
    const sqlPath = path.join(SCHEMA_DIR, file);
    console.log(`📦 Applying ${file}…`);
    const sql = fs.readFileSync(sqlPath, 'utf8');
    try {
      await pool.query(sql);
    } catch (err) {
      if (isIgnorableSchemaError(err)) {
        console.log(`⏭️  ${file} already applied (${err.code || 'n/a'})`);
        continue;
      }
      throw new Error(`${file} failed (${err.code || 'no-code'}): ${err.message}`);
    }
    console.log(`✅ ${file}`);
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
  await applyRemainingSchemaAdditiveSqlFiles();

  console.log('\n✅ Schema sync completed.');
  await pool.end();
  process.exit(0);
}

syncSchema().catch(async (err) => {
  console.error('Fatal schema sync error:', err.message || err);
  await pool.end().catch(() => {});
  process.exit(1);
});
