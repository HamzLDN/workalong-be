#!/bin/bash
set -e

# Helper script to manage the mock database using docker commands
# (since docker-compose has connection issues)

case "$1" in
    start)
        echo "🚀 Starting mock database..."
        docker start workalong-postgres-mock 2>/dev/null || {
            echo "⚠️  Container doesn't exist. Creating it..."
            cd "$(dirname "$0")"
            docker network create workalong-network-mock 2>/dev/null || true
            docker volume create workalong-backend_postgres_data_mock 2>/dev/null || true
            docker run -d --name workalong-postgres-mock --restart unless-stopped \
                -e POSTGRES_USER=workalong \
                -e POSTGRES_PASSWORD=admin \
                -e POSTGRES_DB=users \
                -p 5433:5432 \
                -v workalong-backend_postgres_data_mock:/var/lib/postgresql/data \
                -v "$(pwd)/init-workalong-db.sh:/docker-entrypoint-initdb.d/init-workalong-db.sh:ro" \
                --network workalong-network-mock \
                --health-cmd="pg_isready -U workalong -d users || exit 1" \
                --health-interval=10s \
                --health-timeout=5s \
                --health-retries=10 \
                --health-start-period=40s \
                postgres:16-alpine
        }
        echo "✅ Mock database started"
        echo ""
        echo "Mock database is available at:"
        echo "  Host: localhost"
        echo "  Port: 5433"
        echo "  User: workalong"
        echo "  Password: admin"
        echo "  Database: users"
        ;;
    stop)
        echo "🛑 Stopping mock database..."
        docker stop workalong-postgres-mock
        echo "✅ Mock database stopped"
        ;;
    restart)
        echo "🔄 Restarting mock database..."
        docker restart workalong-postgres-mock
        echo "✅ Mock database restarted"
        ;;
    status)
        docker ps -a | grep workalong-postgres-mock || echo "Mock database container not found"
        ;;
    remove)
        echo "🗑️  Removing mock database container and volume..."
        docker stop workalong-postgres-mock 2>/dev/null || true
        docker rm workalong-postgres-mock
        docker volume rm workalong-backend_postgres_data_mock
        echo "✅ Mock database removed"
        ;;
    logs)
        docker logs -f workalong-postgres-mock
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|remove|logs}"
        echo ""
        echo "Commands:"
        echo "  start   - Start the mock database container"
        echo "  stop    - Stop the mock database container"
        echo "  restart - Restart the mock database container"
        echo "  status  - Show status of the mock database container"
        echo "  remove  - Remove the mock database container and volume"
        echo "  logs    - Show logs from the mock database container"
        exit 1
        ;;
esac



