#!/bin/bash
# Clone mock database to main (prod) database.
# WARNING: This OVERWRITES the main database with mock data. Use with caution.
#
# Usage: ./docker/scripts/clone-mock-to-main.sh
# Or with confirmation skipped: ./docker/scripts/clone-mock-to-main.sh --yes

set -e

MAIN_CONTAINER="${MAIN_CONTAINER:-workalong-postgres}"
MOCK_CONTAINER="${MOCK_CONTAINER:-workalong-postgres-mock}"
DB_USER="${DB_USER:-workalong}"
DB_NAME="${DB_NAME:-users}"
DUMP_FILE="/tmp/workalong_mock_to_main_$$.sql"

cleanup() {
  rm -f "$DUMP_FILE"
}
trap cleanup EXIT

# Skip confirmation if --yes
if [ "$1" != "--yes" ]; then
  echo "⚠️  WARNING: This will OVERWRITE the main/prod database with mock data."
  echo "   All data in the main database will be replaced."
  echo ""
  echo "   Main container: $MAIN_CONTAINER"
  echo "   Mock container: $MOCK_CONTAINER"
  echo ""
  read -p "Type 'yes' to proceed: " confirm
  if [ "$confirm" != "yes" ]; then
    echo "Aborted."
    exit 1
  fi
fi

echo "🔄 Cloning mock database to main database..."

# Check containers
for c in "$MOCK_CONTAINER" "$MAIN_CONTAINER"; do
  if ! docker ps --format '{{.Names}}' | grep -q "^${c}$"; then
    echo "❌ Error: Container '$c' is not running"
    echo "   Start main: docker-compose -f docker-compose.full.yml up -d postgres"
    echo "   Start mock: ./docker/scripts/manage-mock-db.sh start"
    exit 1
  fi
done

echo "⏳ Ensuring databases are ready..."
docker exec "$MOCK_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME"
docker exec "$MAIN_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME"

# Dump from mock
echo "📤 Dumping complete database from mock..."
docker exec "$MOCK_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" \
  --clean --if-exists --no-owner --no-acl > "$DUMP_FILE"

# Drop and recreate main database
echo "🗑️  Clearing main database..."
docker exec "$MAIN_CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;"
docker exec "$MAIN_CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE $DB_NAME;"

# Restore to main
echo "📥 Restoring to main database..."
docker exec -i "$MAIN_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" < "$DUMP_FILE"

# Verify
echo "🔍 Verifying..."
MOCK_COUNT=$(docker exec "$MOCK_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';")
MAIN_COUNT=$(docker exec "$MAIN_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';")

if [ "$MAIN_COUNT" = "$MOCK_COUNT" ]; then
  echo "✅ Table count matches: $MAIN_COUNT tables"
else
  echo "⚠️  Warning: Table count mismatch (Main: $MAIN_COUNT, Mock: $MOCK_COUNT)"
fi

echo ""
echo "✅ Clone complete! Main database now has mock data."
echo ""
echo "Main database is available at:"
echo "  Host: localhost (or DB_HOST)"
echo "  Port: 5432"
echo "  User: $DB_USER"
echo "  Database: $DB_NAME"
echo ""
