import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEMA_DIR = path.join(__dirname, '..', 'database-schema');
const OUTPUT_FILE = path.join(SCHEMA_DIR, 'mock-init.sql');

const PRIORITY_ORDER = [
  'users.sql',
  'sessions.sql',
  'staff.sql',
  'staff_sessions.sql',
  'staff_password_tokens.sql',
  'time_entries.sql',
  'shifts.sql',
  'shift_swaps.sql',
  'shift_swap_requests.sql',
  'device_links.sql',
  'password_reset_tokens.sql',
  'rate_limit_logs.sql',
  'payroll_records.sql',
  'payroll_line_items.sql',
  'security_audit_logs.sql',
  'fraud_flags.sql',
  'activity_feed.sql',
  'api_keys.sql',
  'budgets.sql',
  'login_codes.sql',
  'ip_whitelists.sql',
  'request_signing_keys.sql',
  '00_functions_and_triggers.sql',
  'add-company-structure.sql',
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

  for (const name of PRIORITY_ORDER) {
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
    '-- Source: database-schema/*.sql',
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
