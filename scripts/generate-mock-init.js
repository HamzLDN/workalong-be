import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEMA_DIR = path.join(__dirname, '..', 'database-schema');
const OUTPUT_FILE = path.join(SCHEMA_DIR, 'mock-init.sql');

/**
 * Load order mirrors scripts/run-schema-sync.js:
 * - functions first (tables reference trigger functions via CREATE TRIGGER)
 * - BASE_SCHEMA_FILES
 * - ADDITIVE_MIGRATIONS (+ add-device-links as idempotent extra)
 *
 * Changing run-schema-sync? Update this array to match or docker init stops at first error.
 */
const MOCK_INIT_ORDER = [
  '00_functions_and_triggers.sql',
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
  'add-users.sql',
  'add-session-csrf-token.sql',
  'add-time-entries.sql',
  'add-staff-face-profiles.sql',
  'add_staff_lastname.sql',
  'add-face-embeddings-column.sql',
  'add-company-structure.sql',
  'add-shift-creator-columns.sql',
  'add-shifts-clock-source.sql',
  'add-device-links.sql',
  'add-hr-modules.sql',
  'add-escalation-reports.sql',
];

function listSchemaFiles() {
  return fs
    .readdirSync(SCHEMA_DIR)
    .filter((file) => file.endsWith('.sql') && file !== 'mock-init.sql')
    .sort((a, b) => a.localeCompare(b));
}

function buildOrderedList(files) {
  const fileSet = new Set(files);
  const ordered = [];

  for (const name of MOCK_INIT_ORDER) {
    if (fileSet.has(name)) {
      ordered.push(name);
      fileSet.delete(name);
    }
  }

  const remaining = [...fileSet].sort((a, b) => a.localeCompare(b));
  return [...ordered, ...remaining];
}

function buildContent(orderedFiles) {
  const lines = [
    '-- AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.',
    '-- Run: npm run db:mock:init',
    '-- Source: database-schema/*.sql (order mirrors run-schema-sync.js; see scripts/generate-mock-init.js)',
    '',
    '\\set ON_ERROR_STOP on',
    '',
  ];

  for (const file of orderedFiles) {
    lines.push(`\\i /docker-entrypoint-initdb.d/schema/${file}`);
  }

  lines.push('');
  return lines.join('\n');
}

function main() {
  if (!fs.existsSync(SCHEMA_DIR)) {
    throw new Error(`Schema directory not found: ${SCHEMA_DIR}`);
  }

  const files = listSchemaFiles();
  if (files.length === 0) {
    throw new Error('No .sql files found in database-schema/');
  }

  const ordered = buildOrderedList(files);
  const content = buildContent(ordered);
  fs.writeFileSync(OUTPUT_FILE, content, 'utf8');

  console.log(`Generated ${path.relative(path.join(__dirname, '..'), OUTPUT_FILE)}`);
  console.log(`Included ${ordered.length} SQL files.`);
}

main();
