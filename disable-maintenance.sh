#!/bin/bash
# Disable maintenance mode for the website
# This removes the flag file so nginx serves the normal site

set -e

CONTAINER_NAME="workalong-frontend"
MAINTENANCE_DIR="/var/www/maintenance"
FLAG_FILE="$MAINTENANCE_DIR/maintenance.flag"

echo "🔓 Disabling maintenance mode..."

# Check if container is running
if ! docker ps | grep -q "$CONTAINER_NAME"; then
    echo "❌ Error: Container '$CONTAINER_NAME' is not running"
    echo "   Start it with: docker-compose -p workalong -f docker-compose.full.yml up -d frontend"
    exit 1
fi

# Remove the flag file
if docker exec "$CONTAINER_NAME" test -f "$FLAG_FILE"; then
    docker exec "$CONTAINER_NAME" rm -f "$FLAG_FILE"
    
    # Reload nginx to apply changes
    docker exec "$CONTAINER_NAME" nginx -s reload
    
    echo "✅ Maintenance mode disabled!"
    echo "   Your website is now live again."
else
    echo "ℹ️  Maintenance mode was already disabled."
fi

