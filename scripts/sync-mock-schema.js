/**
 * Safely sync additive backend schema changes to the mock database only.
 * Targets workalong-postgres-mock / localhost:5433 and never reads DB_HOST/DB_PORT
 * from the developer shell or .env for the sync step itself.
 *
 * Usage: node scripts/sync-mock-schema.js
 * Env: SKIP_COMPARE=true to skip npm run db:compare
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { ensureMockPostgresRunning, repoRootFrom } from './_docker-utils.js';

const repoRoot = repoRootFrom(import.meta.url);
const MOCK_CONTAINER = process.env.MOCK_CONTAINER || 'workalong-postgres-mock';

function run(command, args, options = {}) {
  const r = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
    ...options,
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && r.status !== null) process.exit(r.status);
}

function main() {
  ensureMockPostgresRunning(repoRoot);

  console.log('📦 Regenerating database-schema/mock-init.sql...');
  run('npm', ['run', 'db:mock:init']);

  console.log(
    `📦 Applying additive schema sync to mock only (${MOCK_CONTAINER}, localhost:5433)...`
  );
  run(process.execPath, [path.join(repoRoot, 'scripts/run-schema-sync.js')], {
    env: {
      ...process.env,
      DB_HOST: '127.0.0.1',
      DB_PORT: '5433',
      DB_USER: 'workalong',
      DB_PASSWORD: 'admin',
      DB_NAME: 'users',
      NODE_ENV: 'production',
    },
  });

  console.log('📦 Applying mock shared extras...');
  run('npm', ['run', 'db:mock:apply-extras']);

  if (process.env.SKIP_COMPARE !== 'true') {
    console.log('🔍 Comparing main and mock schemas...');
    run('npm', ['run', 'db:compare']);
  }

  console.log('✅ Mock schema sync complete.');
}

main();
