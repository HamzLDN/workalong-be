#!/bin/bash
set -e

# Create workalong database if it doesn't exist
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE workalong'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'workalong')\gexec
EOSQL

echo "✅ Database 'workalong' created (if it didn't exist)"

