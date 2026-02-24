#!/bin/bash
# Remove test users from the database before cloning to prod.
# Deletes users matching: @example.com, test@*
#
# Usage: ./scripts/remove-test-users.sh [mock|main]
#   mock = workalong-postgres-mock (default)
#   main = workalong-postgres

set -e

TARGET="${1:-mock}"
DB_USER="${DB_USER:-workalong}"
DB_NAME="${DB_NAME:-users}"

case "$TARGET" in
  mock)
    CONTAINER="${MOCK_CONTAINER:-workalong-postgres-mock}"
    ;;
  main)
    CONTAINER="${MAIN_CONTAINER:-workalong-postgres}"
    ;;
  *)
    echo "Usage: $0 [mock|main]"
    echo "  mock = remove from mock DB (default)"
    echo "  main = remove from main DB"
    exit 1
    ;;
esac

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "❌ Container '$CONTAINER' is not running"
  echo "   Start mock: ./manage-mock-db.sh start"
  echo "   Start main: docker-compose -f docker-compose.full.yml up -d postgres"
  exit 1
fi

echo "🔍 Finding test users in $CONTAINER..."

# Show what we're about to delete
BEFORE=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -c "
  SELECT COUNT(*) FROM users
  WHERE email ILIKE '%@example.com'
     OR email ILIKE 'test@%'
")

# List the users
echo "Users to be removed:"
docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -c "
  SELECT id, email, name FROM users
  WHERE email ILIKE '%@example.com'
     OR email ILIKE 'test@%'
  ORDER BY id;
" || true

COUNT=$(echo "$BEFORE" | tr -d ' ')
if [ -z "$COUNT" ] || [ "$COUNT" = "0" ]; then
  echo "✅ No test users found."
  exit 0
fi

echo ""
echo "⚠️  About to delete $COUNT test user(s) and their related data (staff, shifts, etc.)."
read -p "Type 'yes' to proceed: " confirm
if [ "$confirm" != "yes" ]; then
  echo "Aborted."
  exit 1
fi

# Delete (CASCADE will remove staff, shifts, time_entries, etc.)
docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "
  DELETE FROM users
  WHERE email ILIKE '%@example.com'
     OR email ILIKE 'test@%';
"

echo "✅ Test users removed."
