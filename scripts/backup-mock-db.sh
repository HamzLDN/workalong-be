#!/bin/bash
# Quick backup of mock database (schema + data)
# Usage: ./scripts/backup-mock-db.sh

set -e

MOCK_CONTAINER="${MOCK_CONTAINER:-workalong-postgres-mock}"
DB_USER="${DB_USER:-workalong}"
DB_NAME="${DB_NAME:-users}"
BACKUP_DIR="$(cd "$(dirname "$0")/.." && pwd)/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/mock-db-$TIMESTAMP.sql"

mkdir -p "$BACKUP_DIR"

if ! docker ps --format '{{.Names}}' | grep -q "^${MOCK_CONTAINER}$"; then
  echo "❌ Mock database container '$MOCK_CONTAINER' is not running"
  echo "   Start with: ./manage-mock-db.sh start"
  exit 1
fi

echo "📤 Backing up mock database..."
docker exec "$MOCK_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl > "$BACKUP_FILE"

echo "✅ Backup saved: $BACKUP_FILE"
