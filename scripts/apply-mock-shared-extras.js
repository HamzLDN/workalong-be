/**
 * Apply tables that live on production Postgres alongside the Workalong backend schema
 * (admin panel WebAuthn + chat, app_settings, billing_reminder_log) so mock schema matches main.
 *
 * Prerequisites: migrate:prod has already been run against mock (or base schema loaded).
 *
 * Usage: node scripts/apply-mock-shared-extras.js
 * Override: MOCK_CONTAINER=other-postgres ADMIN_PANEL_ROOT=/path/to/admin_panel ...
 */
import fs from 'fs';
import path from 'path';
import {
  containerIsRunning,
  dockerExecPsqlFile,
  dockerExecPsqlSql,
  repoRootFrom,
} from './_docker-utils.js';

const repoRoot = repoRootFrom(import.meta.url);
const MOCK_CONTAINER = process.env.MOCK_CONTAINER || 'workalong-postgres-mock';
const ADMIN_PANEL_ROOT = process.env.ADMIN_PANEL_ROOT || path.join(repoRoot, '..', 'admin_panel');

const BILLING_REMINDER_SQL = `CREATE TABLE IF NOT EXISTS billing_reminder_log (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  days_before INTEGER NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;

function main() {
  if (!containerIsRunning(MOCK_CONTAINER)) {
    console.error(`❌ Container '${MOCK_CONTAINER}' is not running`);
    process.exit(1);
  }

  const migrationsDir = path.join(ADMIN_PANEL_ROOT, 'server', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.error(`❌ admin_panel repo not found at ${ADMIN_PANEL_ROOT} (set ADMIN_PANEL_ROOT)`);
    process.exit(1);
  }

  const files = [
    path.join(migrationsDir, '001_admin_passkeys.sql'),
    path.join(migrationsDir, '002_app_settings.sql'),
    path.join(ADMIN_PANEL_ROOT, 'database-schema', 'add-admin-chat.sql'),
  ];

  for (const f of files) {
    console.log(`📦 ${path.basename(f)}`);
    dockerExecPsqlFile(MOCK_CONTAINER, 'workalong', 'users', f);
  }

  console.log('📦 billing_reminder_log (backend billing-reminders helper)');
  dockerExecPsqlSql(MOCK_CONTAINER, 'workalong', 'users', BILLING_REMINDER_SQL);

  console.log('✅ Mock shared extras applied. Run: npm run db:compare');
}

main();
