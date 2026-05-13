import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export function repoRootFrom(importMetaUrl) {
  const __dirname = path.dirname(fileURLToPath(importMetaUrl));
  return path.resolve(__dirname, '..');
}

export function dockerContainerNames() {
  const r = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error((r.stderr || '').trim() || 'docker ps failed');
  }
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function containerIsRunning(name) {
  return dockerContainerNames().includes(name);
}

/** Match scripts/compare-db-schemas.sh normalization for stable schema comparison. */
export function normalizeSchemaDump(raw) {
  return raw
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (t === '') return false;
      if (t.startsWith('--')) return false;
      if (t.startsWith('\\restrict ') || t.startsWith('\\unrestrict ')) return false;
      return true;
    })
    .join('\n');
}

export function dockerPgDumpSchema(container, dbUser, dbName) {
  const r = spawnSync(
    'docker',
    [
      'exec',
      container,
      'pg_dump',
      '-U',
      dbUser,
      '-d',
      dbName,
      '--schema-only',
      '--no-owner',
      '--no-privileges',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0 && !(r.stdout || '').trim()) {
    throw new Error((r.stderr || '').trim() || `pg_dump failed in ${container}`);
  }
  return r.stdout || '';
}

export function dockerExecPsqlFile(container, dbUser, dbName, filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  const r = spawnSync(
    'docker',
    ['exec', '-i', container, 'psql', '-U', dbUser, '-d', dbName, '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0) {
    throw new Error((r.stderr || '').trim() || `psql failed for ${path.basename(filePath)}`);
  }
}

export function dockerExecPsqlSql(container, dbUser, dbName, sql) {
  const r = spawnSync(
    'docker',
    ['exec', '-i', container, 'psql', '-U', dbUser, '-d', dbName, '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0) {
    throw new Error((r.stderr || '').trim() || 'psql failed');
  }
}

export function ensureMockPostgresRunning(repoRoot) {
  const MOCK_CONTAINER = process.env.MOCK_CONTAINER || 'workalong-postgres-mock';
  const NETWORK = 'workalong-network-mock';
  const VOLUME = 'workalong-backend_postgres_data_mock';
  const initScript = path.join(repoRoot, 'docker/scripts/init-workalong-db.sh');

  if (containerIsRunning(MOCK_CONTAINER)) return;

  console.warn('⚠️  Mock database container is not running. Starting it...');

  let r = spawnSync('docker', ['start', MOCK_CONTAINER], { encoding: 'utf8' });
  if (r.status === 0) return;

  if (!fs.existsSync(initScript)) {
    throw new Error(`Init script missing: ${initScript}`);
  }

  spawnSync('docker', ['network', 'create', NETWORK], { encoding: 'utf8' });
  spawnSync('docker', ['volume', 'create', VOLUME], { encoding: 'utf8' });

  const args = [
    'run',
    '-d',
    '--name',
    MOCK_CONTAINER,
    '--restart',
    'unless-stopped',
    '-e',
    'POSTGRES_USER=workalong',
    '-e',
    'POSTGRES_PASSWORD=admin',
    '-e',
    'POSTGRES_DB=users',
    '-p',
    '5433:5432',
    '-v',
    `${VOLUME}:/var/lib/postgresql/data`,
    '-v',
    `${initScript}:/docker-entrypoint-initdb.d/init-workalong-db.sh:ro`,
    '--network',
    NETWORK,
    '--health-cmd=pg_isready -U workalong -d users || exit 1',
    '--health-interval=10s',
    '--health-timeout=5s',
    '--health-retries=10',
    '--health-start-period=40s',
    'postgres:16-alpine',
  ];

  r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error((r.stderr || '').trim() || 'docker run mock postgres failed');
  }
}
