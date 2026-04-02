#!/bin/bash
set -e

BACKEND_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INIT_SCRIPT="$BACKEND_ROOT/docker/scripts/init-workalong-db.sh"

echo "🔄 Cloning main database to mock database (complete copy with schema and data)..."

# Check if main database container is running
if ! docker ps | grep -q "workalong-postgres"; then
    echo "❌ Error: Main database container 'workalong-postgres' is not running"
    echo "   Please start it first with: (cd workalong-backend && docker-compose -f docker-compose.full.yml up -d postgres)"
    exit 1
fi

# Check if mock database container is running
if ! docker ps | grep -q "workalong-postgres-mock"; then
    echo "⚠️  Mock database container is not running. Starting it..."
    docker start workalong-postgres-mock 2>/dev/null || {
        echo "Creating mock database container..."
        docker network create workalong-network-mock 2>/dev/null || true
        docker volume create workalong-backend_postgres_data_mock 2>/dev/null || true
        docker run -d --name workalong-postgres-mock --restart unless-stopped \
            -e POSTGRES_USER=workalong \
            -e POSTGRES_PASSWORD=admin \
            -e POSTGRES_DB=users \
            -p 5433:5432 \
            -v workalong-backend_postgres_data_mock:/var/lib/postgresql/data \
            -v "$INIT_SCRIPT:/docker-entrypoint-initdb.d/init-workalong-db.sh:ro" \
            --network workalong-network-mock \
            --health-cmd="pg_isready -U workalong -d users || exit 1" \
            --health-interval=10s \
            --health-timeout=5s \
            --health-retries=10 \
            --health-start-period=40s \
            postgres:16-alpine
    }
    echo "⏳ Waiting for mock database to be ready..."
    sleep 15
    # Wait for health check
    timeout=60
    while [ $timeout -gt 0 ]; do
        if docker exec workalong-postgres-mock pg_isready -U workalong -d users > /dev/null 2>&1; then
            break
        fi
        sleep 2
        timeout=$((timeout - 2))
    done
fi

# Wait for main database to be ready
echo "⏳ Ensuring main database is ready..."
docker exec workalong-postgres pg_isready -U workalong -d users

# Drop and recreate the database in mock to ensure clean state
echo "🗑️  Clearing mock database..."
docker exec workalong-postgres-mock psql -U workalong -d postgres -c "DROP DATABASE IF EXISTS users;"
docker exec workalong-postgres-mock psql -U workalong -d postgres -c "CREATE DATABASE users;"

# Dump complete database (schema + data) from main database
echo "📤 Dumping complete database from main database (schema + data)..."
docker exec workalong-postgres pg_dump -U workalong -d users --clean --if-exists --no-owner --no-acl > /tmp/workalong_db_complete_dump.sql

# Restore complete database to mock database
echo "📥 Restoring complete database to mock database..."
docker exec -i workalong-postgres-mock psql -U workalong -d users < /tmp/workalong_db_complete_dump.sql

# Verify the clone
echo "🔍 Verifying clone..."
MAIN_COUNT=$(docker exec workalong-postgres psql -U workalong -d users -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';")
MOCK_COUNT=$(docker exec workalong-postgres-mock psql -U workalong -d users -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';")

if [ "$MAIN_COUNT" = "$MOCK_COUNT" ]; then
    echo "✅ Table count matches: $MAIN_COUNT tables"
else
    echo "⚠️  Warning: Table count mismatch (Main: $MAIN_COUNT, Mock: $MOCK_COUNT)"
fi

# Cleanup
rm -f /tmp/workalong_db_complete_dump.sql

echo ""
echo "✅ Database cloned successfully!"
echo ""
echo "Mock database is available at:"
echo "  Host: localhost"
echo "  Port: 5433"
echo "  User: workalong"
echo "  Password: admin"
echo "  Database: users"
echo ""
echo "The mock database now contains the exact same schema and data as the main database."

