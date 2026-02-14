# Workalong database schema

This folder contains the **current database schema** as dumped from the running Postgres container. Each table has its own `.sql` file showing how that table was built (CREATE TABLE, sequence, indexes, constraints, comments).

**Source:** `docker exec workalong-postgres pg_dump -U workalong -d users --schema-only` (table-by-table).

---

## Files

| File | Description |
|------|-------------|
| `00_functions_and_triggers.sql` | Functions and triggers used by the schema (create this first if rebuilding). |
| `users.sql` | Company accounts (root table). |
| `sessions.sql` | Company user sessions (references `users`). |
| `staff.sql` | Staff members (references `users`). |
| `staff_sessions.sql` | Staff login sessions (references `staff`). |
| `staff_password_tokens.sql` | Staff password-set tokens (references `staff`). |
| `shifts.sql` | Shifts (references `users`, `staff`). |
| `time_entries.sql` | Clock-in/out and manual entries (references `users`, `staff`, `shifts`). |
| `shift_swaps.sql` | Legacy shift swap records (references `shifts`, `staff`). |
| `shift_swap_requests.sql` | Shift swap requests (references `shifts`, `staff`). |
| `budgets.sql` | Budgets (references `users`). |
| `fraud_flags.sql` | Fraud alerts (references `users`, `staff`, `time_entries`). |
| `activity_feed.sql` | Activity feed (references `users`, `staff`, `shifts`). |
| `device_links.sql` | Clock-in device/kiosk links (references `users`, `staff`). |
| `password_reset_tokens.sql` | User password reset tokens (references `users`). |
| `login_codes.sql` | Email login codes (references `users`). |
| `api_keys.sql` | API keys (references `users`). |
| `ip_whitelists.sql` | IP whitelist for API (references `users`). |
| `rate_limit_logs.sql` | Rate limit log (references `users`). |
| `request_signing_keys.sql` | Request signing keys (references `users`). |
| `security_audit_logs.sql` | Security audit log (references `users`). |
| `payroll_records.sql` | Payroll runs (references `users`). |
| `payroll_line_items.sql` | Payroll line items (references `payroll_records`, `staff`, etc.). |

---

## Suggested order to create tables (by dependency)

If you were to apply these SQL files to an empty database, use this order to satisfy foreign keys:

1. `00_functions_and_triggers.sql`
2. `users.sql`
3. `sessions.sql`
4. `staff.sql`
5. `staff_sessions.sql`
6. `staff_password_tokens.sql`
7. `shifts.sql`
8. `time_entries.sql`
9. `shift_swaps.sql`
10. `shift_swap_requests.sql`
11. `budgets.sql`
12. `fraud_flags.sql`
13. `activity_feed.sql`
14. `device_links.sql`
15. `password_reset_tokens.sql`
16. `login_codes.sql`
17. `api_keys.sql`
18. `ip_whitelists.sql`
19. `rate_limit_logs.sql`
20. `request_signing_keys.sql`
21. `security_audit_logs.sql`
22. `payroll_records.sql`
23. `payroll_line_items.sql`

---

## How to refresh this folder

From the repo root (with the Postgres container running):

```bash
cd workalong-backend
mkdir -p database-schema
TABLES="activity_feed api_keys budgets device_links fraud_flags ip_whitelists login_codes password_reset_tokens payroll_line_items payroll_records rate_limit_logs request_signing_keys security_audit_logs sessions shift_swap_requests shift_swaps shifts staff staff_password_tokens staff_sessions time_entries users"
for t in $TABLES; do
  docker exec workalong-postgres pg_dump -U workalong -d users --schema-only --no-owner --no-privileges -t "$t" \
    | sed '1,/^SET default_table_access_method/d' \
    | sed '/^\\unrestrict/d' \
    | sed '/^\\restrict/d' \
    > "database-schema/${t}.sql"
done
docker exec workalong-postgres pg_dump -U workalong -d users --schema-only --no-owner --no-privileges \
  | sed -n '1,/^SET default_table_access_method/p' | head -n -1 \
  | sed '/^\\restrict/d' \
  > database-schema/00_functions_and_triggers.sql
```
