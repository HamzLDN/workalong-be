#!/bin/bash
# Setup script for API security features
# This script runs the database migration to add security tables

set -e

echo "🔒 Setting up API security features..."

# Get database connection details from environment or use defaults
DB_USER="${DB_USER:-workalong}"
DB_PASSWORD="${DB_PASSWORD:-admin}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-users}"

# Try psql first, fallback to Node.js script
if command -v psql &> /dev/null; then
    echo "📦 Running database migration with psql..."
    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f migrations/add-api-security.sql
    
    if [ $? -eq 0 ]; then
        echo "✅ Security tables created successfully!"
        echo ""
        echo "📋 Next steps:"
        echo "1. Restart your backend server"
        echo "2. Create an API key via POST /api/security/api-keys"
        echo "3. Use the API key in X-API-Key header for authenticated requests"
        echo ""
        echo "📖 See README-SECURITY.md for detailed documentation"
        exit 0
    else
        echo "⚠️  psql migration failed, trying Node.js fallback..."
    fi
fi

# Fallback to Node.js script
echo "📦 Running database migration with Node.js..."
node scripts/run-security-migration.js

if [ $? -eq 0 ]; then
    exit 0
else
    echo "❌ Migration failed. Please check the error messages above."
    exit 1
fi
