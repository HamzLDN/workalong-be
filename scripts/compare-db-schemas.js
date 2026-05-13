/**
 * Compare schema between main and mock databases.
 * Run before deploy to ensure both databases are in sync.
 *
 * Usage: node scripts/compare-db-schemas.js
 * Or with custom containers: MAIN_CONTAINER=... MOCK_CONTAINER=... node scripts/compare-db-schemas.js
 */
import { containerIsRunning, dockerPgDumpSchema, normalizeSchemaDump } from './_docker-utils.js';

const MAIN_CONTAINER = process.env.MAIN_CONTAINER || 'workalong-postgres';
const MOCK_CONTAINER = process.env.MOCK_CONTAINER || 'workalong-postgres-mock';
const DB_USER = process.env.DB_USER || 'workalong';
const DB_NAME = process.env.DB_NAME || 'users';

function printDiffAround(mainNorm, mockNorm) {
  const a = mainNorm.split('\n');
  const b = mockNorm.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;

  const start = Math.max(0, i - 5);
  const end = Math.min(Math.max(a.length, b.length), i + 20);

  console.log(`First differing line index (0-based): ${i}`);
  console.log('');
  console.log('--- main (slice)');
  for (let j = start; j < Math.min(end, a.length); j += 1) {
    console.log(`${String(j + 1).padStart(6)} | ${a[j]}`);
  }
  console.log('');
  console.log('--- mock (slice)');
  for (let j = start; j < Math.min(end, b.length); j += 1) {
    console.log(`${String(j + 1).padStart(6)} | ${b[j]}`);
  }
}

function main() {
  console.log(`🔄 Comparing schema: ${MAIN_CONTAINER} (main) vs ${MOCK_CONTAINER} (mock)`);
  console.log('');

  for (const c of [MAIN_CONTAINER, MOCK_CONTAINER]) {
    if (!containerIsRunning(c)) {
      console.error(`❌ Error: Container '${c}' is not running`);
      console.error('   Start main: docker-compose -f docker-compose.full.yml up -d postgres');
      console.error(
        '   Start mock: docker/scripts/manage-mock-db.sh start (or npm run db:mock:up)'
      );
      console.error('   Sync them:  ./docker/scripts/clone-db-to-mock.sh');
      process.exit(1);
    }
  }

  console.log('📤 Dumping schema from main database...');
  const mainRaw = dockerPgDumpSchema(MAIN_CONTAINER, DB_USER, DB_NAME);

  console.log('📤 Dumping schema from mock database...');
  const mockRaw = dockerPgDumpSchema(MOCK_CONTAINER, DB_USER, DB_NAME);

  const mainNorm = normalizeSchemaDump(mainRaw);
  const mockNorm = normalizeSchemaDump(mockRaw);

  if (mainNorm === mockNorm) {
    console.log('');
    console.log('✅ Schemas match. Safe to deploy.');
    process.exit(0);
  }

  console.log('');
  console.log('⚠️  Schema mismatch detected!');
  console.log('');
  console.log('Context around first difference:');
  console.log('');
  printDiffAround(mainNorm, mockNorm);
  console.log('');
  console.log('To sync: ./docker/scripts/clone-db-to-mock.sh');
  console.log(
    'To apply migrations: npm run migrate:time-entry-approval (with DB pointing to main)'
  );
  process.exit(1);
}

main();
