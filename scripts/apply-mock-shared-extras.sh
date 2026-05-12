#!/bin/bash
# Apply tables that live on production Postgres alongside the Workalong backend schema
# (admin panel WebAuthn + chat, app_settings, billing_reminder_log) so mock schema matches main.
#
# Prerequisites: migrate:prod has already been run against mock (or base schema loaded).
#
# Usage: bash scripts/apply-mock-shared-extras.sh
# Override: MOCK_CONTAINER=other-postgres ADMIN_PANEL_ROOT=/path/to/admin_panel ...

set -euo pipefail

MOCK_CONTAINER="${MOCK_CONTAINER:-workalong-postgres-mock}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADMIN_PANEL_ROOT="${ADMIN_PANEL_ROOT:-$REPO_ROOT/../admin_panel}"

if ! docker ps --format '{{.Names}}' | grep -qx "$MOCK_CONTAINER"; then
  echo "❌ Container '$MOCK_CONTAINER' is not running"
  exit 1
fi

apply_file() {
  local f="$1"
  echo "📦 $(basename "$f")"
  docker exec -i "$MOCK_CONTAINER" psql -U workalong -d users -v ON_ERROR_STOP=1 <"$f"
}

if [[ ! -d "$ADMIN_PANEL_ROOT/server/migrations" ]]; then
  echo "❌ admin_panel repo not found at $ADMIN_PANEL_ROOT (set ADMIN_PANEL_ROOT)"
  exit 1
fi

apply_file "$ADMIN_PANEL_ROOT/server/migrations/001_admin_passkeys.sql"
apply_file "$ADMIN_PANEL_ROOT/server/migrations/002_app_settings.sql"
apply_file "$ADMIN_PANEL_ROOT/database-schema/add-admin-chat.sql"

echo "📦 billing_reminder_log (backend billing-reminders helper)"
docker exec -i "$MOCK_CONTAINER" psql -U workalong -d users -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS billing_reminder_log (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  days_before INTEGER NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SQL

echo "✅ Mock shared extras applied. Run: npm run db:compare"
