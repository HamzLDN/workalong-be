/**
 * Delete users (and CASCADE-dependent rows) whose email matches test-account heuristics.
 *
 * Default (safe): obvious CI / fixture accounts — not every substring "test" (would hit e.g. testeraq@gmail.com).
 *   - email ILIKE '%@example.com%'
 *   - OR email ILIKE 'cookie-test%'
 *   - OR email ILIKE 'security-test%'
 *
 * Broad match (use with care):
 *   node scripts/delete-users-by-email-pattern.js --pattern '%test%'
 *
 * Usage:
 *   node scripts/delete-users-by-email-pattern.js
 *   node scripts/delete-users-by-email-pattern.js --dry-run
 *   node scripts/delete-users-by-email-pattern.js --pattern '%@example.com'
 *
 * Clears FK blockers: fraud_flags.resolved_by, time_entries.approved_by (no ON DELETE on those FKs).
 */
import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
});

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const pi = args.indexOf('--pattern');
  let pattern = null;
  if (pi !== -1 && args[pi + 1]) {
    pattern = args[pi + 1];
  }
  const useDefaultHeuristic = !pattern;
  return { dryRun, pattern, useDefaultHeuristic };
}

async function main() {
  const { dryRun, pattern, useDefaultHeuristic } = parseArgs();

  if (!process.env.DB_HOST || !process.env.DB_NAME) {
    console.error('Set DB_* in .env');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    let list;
    if (useDefaultHeuristic) {
      list = await client.query(
        `SELECT id, email, name FROM users
         WHERE email ILIKE '%@example.com%'
            OR email ILIKE 'cookie-test%'
            OR email ILIKE 'security-test%'
         ORDER BY id`
      );
      console.log(
        'Using default test-account filter (@example.com, cookie-test%, security-test%).'
      );
    } else {
      list = await client.query(
        `SELECT id, email, name FROM users WHERE LOWER(email) LIKE LOWER($1) ORDER BY id`,
        [pattern]
      );
      console.log(`Using pattern: ${JSON.stringify(pattern)}`);
    }

    if (list.rows.length === 0) {
      console.log('No users matched.');
      return;
    }

    console.log(`Matched ${list.rows.length} user(s):`);
    for (const r of list.rows) {
      console.log(`  id=${r.id} email=${r.email} name=${r.name || ''}`);
    }

    if (dryRun) {
      console.log('\n--dry-run: no changes made.');
      return;
    }

    const ids = list.rows.map((r) => r.id);

    await client.query('BEGIN');

    await client.query(
      `UPDATE fraud_flags SET resolved_by = NULL WHERE resolved_by = ANY($1::bigint[])`,
      [ids]
    );
    await client.query(
      `UPDATE time_entries SET approved_by = NULL WHERE approved_by = ANY($1::bigint[])`,
      [ids]
    );

    const del = await client.query(
      `DELETE FROM users WHERE id = ANY($1::bigint[]) RETURNING id, email`,
      [ids]
    );

    await client.query('COMMIT');
    console.log(`\nDeleted ${del.rowCount} user row(s).`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e.message || e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
