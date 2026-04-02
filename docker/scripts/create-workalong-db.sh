#!/bin/bash
# Script to create the 'workalong' database in PostgreSQL

set -e

BACKEND_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$BACKEND_ROOT"

echo "=== Creating 'workalong' database ==="

# Check if postgres container is running
if ! docker ps | grep -q workalong-postgres; then
    echo "❌ PostgreSQL container is not running"
    echo "Start it with: docker-compose -f docker-compose.full.yml up -d postgres"
    exit 1
fi

# Create the database
echo "Creating database 'workalong'..."
docker exec workalong-postgres psql -U workalong -d postgres -c "CREATE DATABASE workalong;" 2>&1 || {
    # Check if database already exists
    if docker exec workalong-postgres psql -U workalong -d postgres -c "\l" | grep -q workalong; then
        echo "✅ Database 'workalong' already exists"
    else
        echo "❌ Failed to create database"
        exit 1
    fi
}

echo "✅ Database 'workalong' created successfully"
echo ""
echo "=== Listing all databases ==="
docker exec workalong-postgres psql -U workalong -d postgres -c "\l"

