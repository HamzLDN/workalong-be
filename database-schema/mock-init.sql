-- AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.
-- Run: npm run db:mock:init
-- Source: database-schema/*.sql (order mirrors run-schema-sync.js; see scripts/generate-mock-init.js)

\set ON_ERROR_STOP on

\i /docker-entrypoint-initdb.d/schema/00_functions_and_triggers.sql
\i /docker-entrypoint-initdb.d/schema/users.sql
\i /docker-entrypoint-initdb.d/schema/sessions.sql
\i /docker-entrypoint-initdb.d/schema/password_reset_tokens.sql
\i /docker-entrypoint-initdb.d/schema/login_codes.sql
\i /docker-entrypoint-initdb.d/schema/api_keys.sql
\i /docker-entrypoint-initdb.d/schema/ip_whitelists.sql
\i /docker-entrypoint-initdb.d/schema/request_signing_keys.sql
\i /docker-entrypoint-initdb.d/schema/staff.sql
\i /docker-entrypoint-initdb.d/schema/staff_sessions.sql
\i /docker-entrypoint-initdb.d/schema/staff_password_tokens.sql
\i /docker-entrypoint-initdb.d/schema/payroll_records.sql
\i /docker-entrypoint-initdb.d/schema/payroll_line_items.sql
\i /docker-entrypoint-initdb.d/schema/budgets.sql
\i /docker-entrypoint-initdb.d/schema/shifts.sql
\i /docker-entrypoint-initdb.d/schema/time_entries.sql
\i /docker-entrypoint-initdb.d/schema/shift_swap_requests.sql
\i /docker-entrypoint-initdb.d/schema/shift_swaps.sql
\i /docker-entrypoint-initdb.d/schema/activity_feed.sql
\i /docker-entrypoint-initdb.d/schema/fraud_flags.sql
\i /docker-entrypoint-initdb.d/schema/security_audit_logs.sql
\i /docker-entrypoint-initdb.d/schema/rate_limit_logs.sql
\i /docker-entrypoint-initdb.d/schema/device_links.sql
\i /docker-entrypoint-initdb.d/schema/add-users.sql
\i /docker-entrypoint-initdb.d/schema/add-session-csrf-token.sql
\i /docker-entrypoint-initdb.d/schema/add-time-entries.sql
\i /docker-entrypoint-initdb.d/schema/add-staff-face-profiles.sql
\i /docker-entrypoint-initdb.d/schema/add_staff_lastname.sql
\i /docker-entrypoint-initdb.d/schema/add-face-embeddings-column.sql
\i /docker-entrypoint-initdb.d/schema/add-company-structure.sql
\i /docker-entrypoint-initdb.d/schema/add-shift-creator-columns.sql
\i /docker-entrypoint-initdb.d/schema/add-shifts-clock-source.sql
\i /docker-entrypoint-initdb.d/schema/add-device-links.sql
\i /docker-entrypoint-initdb.d/schema/add-workspace-subdomain.sql
