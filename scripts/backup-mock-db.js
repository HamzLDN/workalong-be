/**
 * Quick backup of mock database (schema + data)
 * Usage: node scripts/backup-mock-db.js
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { containerIsRunning, repoRootFrom } from './_docker-utils.js';

const MOCK_CONTAINER = process.env.MOCK_CONTAINER || 'workalong-postgres-mock';
const DB_USER = process.env.DB_USER || 'workalong';
const DB_NAME = process.env.DB_NAME || 'users';

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function main() {
  const repoRoot = repoRootFrom(import.meta.url);
  const backupDir = path.join(repoRoot, 'backups');
  const backupFile = path.join(backupDir, `mock-db-${timestamp()}.sql`);

  if (!containerIsRunning(MOCK_CONTAINER)) {
    console.error(`❌ Mock database container '${MOCK_CONTAINER}' is not running`);
    console.error('   Start with: docker/scripts/manage-mock-db.sh start');
    process.exit(1);
  }

  fs.mkdirSync(backupDir, { recursive: true });

  console.log('📤 Backing up mock database...');
  const r = spawnSync(
    'docker',
    ['exec', MOCK_CONTAINER, 'pg_dump', '-U', DB_USER, '-d', DB_NAME, '--no-owner', '--no-acl'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  if (r.status !== 0) {
    console.error(r.stderr || 'pg_dump failed');
    process.exit(1);
  }

  fs.writeFileSync(backupFile, r.stdout, 'utf8');
  console.log(`✅ Backup saved: ${backupFile}`);
}

main();
