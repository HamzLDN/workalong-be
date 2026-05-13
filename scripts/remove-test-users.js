/**
 * Remove test users from the database before cloning to prod.
 * Deletes users matching: @example.com, test@*
 *
 * Usage: node scripts/remove-test-users.js [mock|main]
 *   mock = workalong-postgres-mock (default)
 *   main = workalong-postgres
 */
import { spawnSync } from 'child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { containerIsRunning } from './_docker-utils.js';

const TARGET = process.argv[2] || 'mock';
const DB_USER = process.env.DB_USER || 'workalong';
const DB_NAME = process.env.DB_NAME || 'users';

const COUNT_SQL = `
  SELECT COUNT(*) FROM users
  WHERE email ILIKE '%@example.com'
     OR email ILIKE 'test@%'
`;

const LIST_SQL = `
  SELECT id, email, name FROM users
  WHERE email ILIKE '%@example.com'
     OR email ILIKE 'test@%'
  ORDER BY id;
`;

const DELETE_SQL = `
  DELETE FROM users
  WHERE email ILIKE '%@example.com'
     OR email ILIKE 'test@%';
`;

function containerForArg(target) {
  if (target === 'mock') return process.env.MOCK_CONTAINER || 'workalong-postgres-mock';
  if (target === 'main') return process.env.MAIN_CONTAINER || 'workalong-postgres';
  return null;
}

function dockerPsql(container, sql, flags = []) {
  const args = ['exec', container, 'psql', '-U', DB_USER, '-d', DB_NAME, ...flags, '-c', sql];
  return spawnSync('docker', args, { encoding: 'utf8' });
}

async function main() {
  const CONTAINER = containerForArg(TARGET);
  if (!CONTAINER) {
    console.error(`Usage: node scripts/remove-test-users.js [mock|main]
  mock = remove from mock DB (default)
  main = remove from main DB`);
    process.exit(1);
  }

  if (!containerIsRunning(CONTAINER)) {
    console.error(`❌ Container '${CONTAINER}' is not running`);
    console.error('   Start mock: docker/scripts/manage-mock-db.sh start');
    console.error('   Start main: docker-compose -f docker-compose.full.yml up -d postgres');
    process.exit(1);
  }

  console.log(`🔍 Finding test users in ${CONTAINER}...`);

  const before = dockerPsql(CONTAINER, COUNT_SQL, ['-t']);
  if (before.status !== 0) {
    console.error(before.stderr || 'psql failed');
    process.exit(1);
  }

  console.log('Users to be removed:');
  const list = dockerPsql(CONTAINER, LIST_SQL, ['-t']);
  if (list.stdout) process.stdout.write(list.stdout);

  const count = parseInt(String(before.stdout).replace(/\s/g, ''), 10);
  if (!count || Number.isNaN(count)) {
    console.log('✅ No test users found.');
    process.exit(0);
  }

  console.log('');
  console.log(
    `⚠️  About to delete ${count} test user(s) and their related data (staff, shifts, etc.).`
  );

  const rl = readline.createInterface({ input, output });
  let confirm;
  try {
    confirm = await rl.question("Type 'yes' to proceed: ");
  } finally {
    rl.close();
  }

  if (String(confirm).trim() !== 'yes') {
    console.log('Aborted.');
    process.exit(1);
  }

  const del = dockerPsql(CONTAINER, DELETE_SQL);
  if (del.status !== 0) {
    console.error(del.stderr || 'delete failed');
    process.exit(1);
  }

  console.log('✅ Test users removed.');
}

await main();
