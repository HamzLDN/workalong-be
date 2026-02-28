#!/bin/bash
# Compare schema between main and mock databases.
# Run before deploy to ensure both databases are in sync.
# Usage: ./scripts/compare-db-schemas.sh
# Or with custom hosts: MAIN_CONTAINER=... MOCK_CONTAINER=... ./scripts/compare-db-schemas.sh

set -e

MAIN_CONTAINER="${MAIN_CONTAINER:-workalong-postgres}"
MOCK_CONTAINER="${MOCK_CONTAINER:-workalong-postgres-mock}"
DB_USER="${DB_USER:-workalong}"
DB_NAME="${DB_NAME:-users}"
TMPDIR="${TMPDIR:-/tmp}"

MAIN_DUMP="$TMPDIR/workalong_schema_main_$$.sql"
MOCK_DUMP="$TMPDIR/workalong_schema_mock_$$.sql"

cleanup() {
  rm -f "$MAIN_DUMP" "$MOCK_DUMP"
}
trap cleanup EXIT

echo "🔄 Comparing schema: $MAIN_CONTAINER (main) vs $MOCK_CONTAINER (mock)"
echo ""

# Check containers
for c in "$MAIN_CONTAINER" "$MOCK_CONTAINER"; do
  if ! docker ps --format '{{.Names}}' | grep -q "^${c}$"; then
    echo "❌ Error: Container '$c' is not running"
    echo "   Start main: docker-compose -f docker-compose.full.yml up -d postgres"
    echo "   Start mock: ./manage-mock-db.sh start"
    echo "   Sync them:  ./clone-db-to-mock.sh"
    exit 1
  fi
done

# Dump schema only (no data) - strip comment lines that vary
echo "📤 Dumping schema from main database..."
docker exec "$MAIN_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" \
  --schema-only --no-owner --no-privileges 2>/dev/null \
  | grep -v '^--' | grep -v '^$' | sed '/^\\restrict /d' | sed '/^\\unrestrict /d' \
  > "$MAIN_DUMP" || true

echo "📤 Dumping schema from mock database..."
docker exec "$MOCK_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" \
  --schema-only --no-owner --no-privileges 2>/dev/null \
  | grep -v '^--' | grep -v '^$' | sed '/^\\restrict /d' | sed '/^\\unrestrict /d' \
  > "$MOCK_DUMP" || true

# Compare
if diff -q "$MAIN_DUMP" "$MOCK_DUMP" > /dev/null 2>&1; then
  echo ""
  echo "✅ Schemas match. Safe to deploy."
  exit 0
else
  echo ""
  echo "⚠️  Schema mismatch detected!"
  echo ""
  echo "Differences (main vs mock):"
  diff -u "$MAIN_DUMP" "$MOCK_DUMP" || true
  echo ""
  echo "To sync: ./clone-db-to-mock.sh"
  echo "To apply migrations: npm run migrate:time-entry-approval (with DB pointing to main)"
  exit 1
fi
