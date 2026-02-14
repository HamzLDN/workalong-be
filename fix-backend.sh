#!/bin/bash
# Script to fix unhealthy backend container

set -e

cd "$(dirname "$0")"

echo "=== Removing unhealthy backend container ==="
docker-compose -p workalong -f docker-compose.full.yml rm -f backend 2>/dev/null || true
docker rm -f workalong-backend 2>/dev/null || true

echo ""
echo "=== Checking PostgreSQL status ==="
if ! docker exec workalong-postgres pg_isready -U workalong 2>/dev/null; then
    echo "WARNING: PostgreSQL is not ready. Attempting to restart..."
    docker-compose -p workalong -f docker-compose.full.yml restart postgres
    echo "Waiting for PostgreSQL to become ready (30 seconds)..."
    sleep 30
    
    # Retry checking
    for i in {1..10}; do
        if docker exec workalong-postgres pg_isready -U workalong 2>/dev/null; then
            echo "✅ PostgreSQL is now ready!"
            break
        fi
        echo "Waiting... ($i/10)"
        sleep 3
    done
    
    if ! docker exec workalong-postgres pg_isready -U workalong 2>/dev/null; then
        echo "ERROR: PostgreSQL is still not ready after restart!"
        echo "PostgreSQL logs:"
        docker logs workalong-postgres --tail 20
        exit 1
    fi
else
    echo "✅ PostgreSQL is ready"
fi

echo ""
echo "=== Starting backend container ==="
docker-compose -p workalong -f docker-compose.full.yml up -d backend

echo ""
echo "=== Waiting for backend to start (15 seconds) ==="
sleep 15

echo ""
echo "=== Backend container status ==="
docker ps --filter "name=workalong-backend" --format "table {{.Names}}\t{{.Status}}"

echo ""
echo "=== Backend logs (last 30 lines) ==="
docker logs workalong-backend --tail 30 2>&1

echo ""
echo "=== Testing health endpoint ==="
docker exec workalong-backend curl -f http://localhost:8080/api/health 2>&1 || {
    echo "WARNING: Health endpoint not responding"
    echo "Checking if backend process is running..."
    docker exec workalong-backend ps aux | grep node || echo "No node process found"
}

echo ""
echo "=== Done ==="

