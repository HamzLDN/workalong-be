/**
 * Remove users left behind by security tests and other scripts.
 *
 * Default match (recommended): @example.com addresses where email or name contains "test"
 * (avoids real addresses like testeraq@gmail.com). Use --loose for substring "test" anywhere.
 *
 *   node scripts/cleanup-test-users.js              # dry-run (uses .env DB_*)
 *   node scripts/cleanup-test-users.js --execute    # delete
 *   node scripts/cleanup-test-users.js --execute --loose
 *
 * Target another instance (overrides .env for this run only):
 *   node scripts/cleanup-test-users.js --db-port 5432
 *   node scripts/cleanup-test-users.js --db-host 127.0.0.1 --db-port 5432 --db-name users --execute
 *
 * Flags: --db-host --db-port --db-user --db-password --db-name (aliases: --host --port --user --password --database)
 */
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

function parseArgs(argv) {
  const flags = { execute: false, loose: false };
  const db = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--execute') flags.execute = true;
    else if (a === '--loose') flags.loose = true;
    else if (a === '--db-host' || a === '--host') db.host = argv[++i];
    else if (a === '--db-port' || a === '--port') db.port = argv[++i];
    else if (a === '--db-user' || a === '--user') db.user = argv[++i];
    else if (a === '--db-password' || a === '--password') db.password = argv[++i];
    else if (a === '--db-name' || a === '--database') db.database = argv[++i];
  }
  return { flags, db };
}

function createPool(dbOverrides) {
  const user = dbOverrides.user || process.env.DB_USER;
  const password = dbOverrides.password !== undefined ? dbOverrides.password : process.env.DB_PASSWORD;
  const host = dbOverrides.host || process.env.DB_HOST;
  const port = parseInt(dbOverrides.port || process.env.DB_PORT || '5432', 10);
  const database = dbOverrides.database || process.env.DB_NAME;
  return {
    pool: new Pool({ user, password, host, port, database }),
    connectInfo: { user, host, port, database },
  };
}

const MATCH_STRICT = `(
  LOWER(email) LIKE '%@example.com'
  AND (
    LOWER(email) LIKE '%test%'
    OR LOWER(COALESCE(name, '')) LIKE '%test%'
  )
)`;

const MATCH_LOOSE =
  "LOWER(email) LIKE '%test%' OR LOWER(COALESCE(name, '')) LIKE '%test%'";

async function main() {
  const { flags, db: dbOverrides } = parseArgs(process.argv);
  const { execute, loose } = flags;
  const match = loose ? MATCH_LOOSE : MATCH_STRICT;

  const { pool, connectInfo } = createPool(dbOverrides);
  if (!connectInfo.host || !connectInfo.database) {
    console.error('Set DB_HOST and DB_NAME in .env, or pass --db-host / --db-name');
    process.exit(1);
  }

  const usingOverrides = Object.keys(dbOverrides).length > 0;
  console.log(
    `Connecting: ${connectInfo.user}@${connectInfo.host}:${connectInfo.port}/${connectInfo.database}${usingOverrides ? ' (CLI overrides)' : ''}\n`
  );

  const preview = await pool.query(
    `SELECT id, email, name, created_at FROM users WHERE ${match} ORDER BY id`
  );

  const mode = loose ? 'LOOSE: email or name contains "test" anywhere' : 'STRICT: @example.com and "test" in email or name';
  console.log(`Mode: ${mode}`);
  console.log(`Found ${preview.rows.length} user(s):\n`);
  for (const row of preview.rows) {
    console.log(`  id=${row.id}  email=${row.email}  name=${row.name || '—'}  created_at=${row.created_at}`);
  }

  if (!execute) {
    console.log('\nDry-run only. Re-run with --execute to delete. Add --loose to match any email/name containing "test".');
    await pool.end();
    return;
  }

  if (preview.rows.length === 0) {
    console.log('\nNothing to delete.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE fraud_flags SET resolved_by = NULL
       WHERE resolved_by IN (SELECT id FROM users WHERE ${match})`
    );

    const col = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'time_entries' AND column_name = 'approved_by'`
    );
    if (col.rows.length > 0) {
      await client.query(
        `UPDATE time_entries SET approved_by = NULL
         WHERE approved_by IN (SELECT id FROM users WHERE ${match})`
      );
    }

    const del = await client.query(
      `DELETE FROM users WHERE ${match} RETURNING id, email`
    );

    await client.query('COMMIT');
    console.log(`\nDeleted ${del.rowCount} user(s).`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\nRollback:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
