#!/bin/bash
# Complete PostgreSQL reset script

set -e

BACKEND_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$BACKEND_ROOT"

echo "=== Stopping all containers ==="
docker-compose -f docker-compose.full.yml stop

echo ""
echo "=== Removing PostgreSQL container ==="
docker-compose -f docker-compose.full.yml rm -f postgres

echo ""
echo "=== Checking for PostgreSQL volume ==="
VOLUME_NAME=$(docker volume ls | grep postgres_data | awk '{print $2}' | head -1)
if [ ! -z "$VOLUME_NAME" ]; then
    echo "Found volume: $VOLUME_NAME"
    read -p "Do you want to DELETE the PostgreSQL data volume? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Removing volume: $VOLUME_NAME"
        docker volume rm "$VOLUME_NAME" 2>&1 || echo "Volume removal failed or already removed"
    else
        echo "Keeping existing volume"
    fi
else
    echo "No postgres_data volume found"
fi

echo ""
echo "=== Starting PostgreSQL fresh ==="
docker-compose -f docker-compose.full.yml up -d postgres

echo ""
echo "=== Waiting for PostgreSQL to initialize (30 seconds) ==="
sleep 30

echo ""
echo "=== Checking PostgreSQL container status ==="
docker ps --filter "name=workalong-postgres" --format "table {{.Names}}\t{{.Status}}"

echo ""
echo "=== PostgreSQL logs (last 40 lines) ==="
docker logs workalong-postgres --tail 40 2>&1

echo ""
echo "=== Testing PostgreSQL connection ==="
for i in {1..20}; do
    if docker exec workalong-postgres pg_isready -U workalong 2>&1 | grep -q "accepting connections"; then
        echo "✅ PostgreSQL is ready!"
        docker exec workalong-postgres pg_isready -U workalong
        echo ""
        echo "=== Testing database access ==="
        docker exec workalong-postgres psql -U workalong -d users -c "SELECT version();" 2>&1 | head -5
        exit 0
    fi
    echo "Waiting for PostgreSQL... ($i/20)"
    sleep 3
done

echo ""
echo "❌ PostgreSQL failed to become ready after 60 seconds"
echo ""
echo "=== Full container inspection ==="
docker inspect workalong-postgres --format='{{json .State}}' | python3 -m json.tool 2>/dev/null | head -20 || docker inspect workalong-postgres | grep -A 10 State

echo ""
echo "=== Checking if PostgreSQL process is running ==="
docker exec workalong-postgres ps aux 2>&1 | grep postgres || echo "Cannot exec into container"

exit 1

