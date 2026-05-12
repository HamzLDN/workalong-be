#!/bin/bash
# Safely sync additive backend schema changes to the mock database only.
# This intentionally targets workalong-postgres-mock / localhost:5433 and never
# reads DB_HOST/DB_PORT from the developer shell or .env.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOCK_CONTAINER="${MOCK_CONTAINER:-workalong-postgres-mock}"

cd "$REPO_ROOT"

if ! docker ps --format '{{.Names}}' | grep -qx "$MOCK_CONTAINER"; then
  echo "⚠️  Mock database container is not running. Starting it..."
  ./docker/scripts/manage-mock-db.sh start
fi

echo "📦 Regenerating database-schema/mock-init.sql..."
npm run db:mock:init

echo "📦 Applying additive schema sync to mock only (${MOCK_CONTAINER}, localhost:5433)..."
DB_HOST=127.0.0.1 \
DB_PORT=5433 \
DB_USER=workalong \
DB_PASSWORD=admin \
DB_NAME=users \
NODE_ENV=production \
node scripts/run-schema-sync.js

echo "📦 Applying mock shared extras..."
npm run db:mock:apply-extras

if [[ "${SKIP_COMPARE:-false}" != "true" ]]; then
  echo "🔍 Comparing main and mock schemas..."
  npm run db:compare
fi

echo "✅ Mock schema sync complete."
