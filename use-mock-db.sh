#!/bin/bash
# Helper script to set environment variables for using the mock database

export DB_HOST=localhost
export DB_PORT=5433
export MOCK_DB=true

echo "✅ Environment variables set for mock database:"
echo "   DB_HOST=$DB_HOST"
echo "   DB_PORT=$DB_PORT"
echo "   MOCK_DB=$MOCK_DB"
echo ""
echo "To use the mock database, run your command with these variables:"
echo "   DB_HOST=localhost DB_PORT=5433 MOCK_DB=true node index.js"
echo ""
echo "Or source this script and run your command:"
echo "   source ./use-mock-db.sh"
echo "   node index.js"





