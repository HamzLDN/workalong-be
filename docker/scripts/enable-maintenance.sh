#!/bin/bash
# Enable maintenance mode for the website
# This creates a flag file that nginx checks to serve the maintenance page

set -e

CONTAINER_NAME="workalong-frontend"
MAINTENANCE_DIR="/var/www/maintenance"
FLAG_FILE="$MAINTENANCE_DIR/maintenance.flag"

echo "🔧 Enabling maintenance mode..."

# Check if container is running
if ! docker ps | grep -q "$CONTAINER_NAME"; then
    echo "❌ Error: Container '$CONTAINER_NAME' is not running"
    echo "   Start it with: docker-compose -p workalong -f docker-compose.full.yml up -d frontend"
    exit 1
fi

# Create maintenance directory if it doesn't exist
docker exec "$CONTAINER_NAME" mkdir -p "$MAINTENANCE_DIR"

# Create the flag file
docker exec "$CONTAINER_NAME" touch "$FLAG_FILE"
docker exec "$CONTAINER_NAME" chown www-data:www-data "$FLAG_FILE"
docker exec "$CONTAINER_NAME" chmod 644 "$FLAG_FILE"

# Reload nginx to apply changes
docker exec "$CONTAINER_NAME" nginx -s reload

echo "✅ Maintenance mode enabled!"
echo "   Your website is now showing the maintenance page."
echo ""
echo "   To disable maintenance mode, run:"
echo "   ./docker/scripts/disable-maintenance.sh"

