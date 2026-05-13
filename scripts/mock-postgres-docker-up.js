/**
 * Starts mock Postgres the same way as docker-compose.mock.yml without docker compose
 * (avoids compose v2 -f quirks and docker-compose/http+docker DOCKER_HOST issues).
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const NAME = 'workalong-postgres-mock';
const VOL_NAME = 'workalong-backend_postgres_data_mock';
const MOCK_INIT_SQL = path.join(REPO_ROOT, 'database-schema', 'mock-init.sql');
const SCHEMA_DIR = path.join(REPO_ROOT, 'database-schema');

const recreate = process.argv.includes('--recreate');

function dockerEnv() {
  const env = { ...process.env };
  delete env.DOCKER_CONTEXT;

  const h = env.DOCKER_HOST || '';
  const badScheme = !h || h.includes('http+docker');
  if (badScheme && fs.existsSync('/var/run/docker.sock')) {
    env.DOCKER_HOST = 'unix:///var/run/docker.sock';
  }
  return env;
}

function docker(args, silent = false) {
  const r = spawnSync('docker', args, {
    env: dockerEnv(),
    encoding: 'utf8',
    stdio: silent ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  const code = typeof r.status === 'number' ? r.status : 1;
  if (silent && r.stderr && code !== 0) {
    // ignore expected "no such volume" noise
    if (!String(r.stderr).includes('no such')) {
      process.stderr.write(r.stderr);
    }
  }
  return code;
}

function containerRunningOrStarted() {
  const r = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', NAME], {
    env: dockerEnv(),
    encoding: 'utf8',
  });
  if (r.status !== 0) return false;
  if (String(r.stdout).trim() === 'true') return true;
  return docker(['start', NAME]) === 0;
}

function runNewContainer() {
  if (!fs.existsSync(MOCK_INIT_SQL)) {
    console.error(`Missing ${path.relative(REPO_ROOT, MOCK_INIT_SQL)} — run npm run db:mock:init`);
    process.exit(1);
  }

  docker(['volume', 'create', VOL_NAME], true);

  const code = docker([
    'run',
    '-d',
    '--name',
    NAME,
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
    `${VOL_NAME}:/var/lib/postgresql/data`,
    '-v',
    `${MOCK_INIT_SQL}:/docker-entrypoint-initdb.d/001-mock-init.sql:ro`,
    '-v',
    `${SCHEMA_DIR}:/docker-entrypoint-initdb.d/schema:ro`,
    '--health-cmd',
    'pg_isready -U workalong -d users || exit 1',
    '--health-interval=10s',
    '--health-timeout=5s',
    '--health-retries=10',
    '--health-start-period=40s',
    'postgres:16-alpine',
  ]);

  process.exit(code === 0 ? 0 : 1);
}

if (recreate) {
  docker(['rm', '-f', NAME], true);
  docker(['volume', 'rm', VOL_NAME], true);
  runNewContainer();
} else if (containerRunningOrStarted()) {
  process.exit(0);
} else {
  runNewContainer();
}
