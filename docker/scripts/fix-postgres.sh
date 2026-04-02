#!/bin/bash
# Script to fix PostgreSQL container

set -e

BACKEND_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$BACKEND_ROOT"

echo "=== Checking PostgreSQL container status ==="
docker ps -a --filter "name=workalong-postgres" --format "table {{.Names}}\t{{.Status}}"

echo ""
echo "=== Restarting PostgreSQL ==="
docker-compose -f docker-compose.full.yml stop postgres
docker-compose -f docker-compose.full.yml rm -f postgres
docker-compose -f docker-compose.full.yml up -d postgres

echo ""
echo "=== Waiting for PostgreSQL to start (20 seconds) ==="
sleep 20

echo ""
echo "=== Checking PostgreSQL health ==="
for i in {1..15}; do
    if docker exec workalong-postgres pg_isready -U workalong 2>/dev/null; then
        echo "✅ PostgreSQL is ready!"
        docker exec workalong-postgres pg_isready -U workalong
        exit 0
    fi
    echo "Waiting for PostgreSQL... ($i/15)"
    sleep 2
done

echo ""
echo "❌ PostgreSQL failed to become ready"
echo "=== PostgreSQL logs ==="
docker logs workalong-postgres --tail 30

echo ""
echo "=== Container status ==="
docker inspect workalong-postgres --format='Status: {{.State.Status}}, Health: {{.State.Health.Status}}'

exit 1

