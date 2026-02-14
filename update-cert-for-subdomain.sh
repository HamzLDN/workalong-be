#!/bin/bash
# Script to update Let's Encrypt certificate to include api.workalong.co.uk subdomain

set -e

echo "🔐 Updating SSL certificate to include api.workalong.co.uk subdomain"
echo ""

# Check if certbot is installed
if ! command -v certbot &> /dev/null; then
    echo "❌ certbot is not installed. Installing..."
    apt-get update && apt-get install -y certbot
fi

# Stop nginx temporarily (if running outside Docker)
if systemctl is-active --quiet nginx 2>/dev/null; then
    echo "⏸️  Stopping nginx..."
    systemctl stop nginx
    RESTART_NGINX=true
else
    RESTART_NGINX=false
fi

# Get new certificate with subdomain
echo "📋 Requesting new certificate with api.workalong.co.uk..."
certbot certonly --standalone \
    -d workalong.co.uk \
    -d www.workalong.co.uk \
    -d api.workalong.co.uk \
    --non-interactive \
    --agree-tos \
    --email admin@workalong.co.uk \
    --expand

# Copy certificates to Docker SSL directory
echo "📋 Copying certificates to Docker SSL directory..."
SSL_DIR="/root/workalong-frontend/docker/ssl"
mkdir -p "$SSL_DIR"

CERT_DIR="/etc/letsencrypt/live/workalong.co.uk"
if [ -d "$CERT_DIR" ]; then
    cp "$CERT_DIR/fullchain.pem" "$SSL_DIR/fullchain.pem"
    cp "$CERT_DIR/privkey.pem" "$SSL_DIR/privkey.pem"
    chmod 644 "$SSL_DIR/fullchain.pem"
    chmod 600 "$SSL_DIR/privkey.pem"
    echo "✅ Certificates copied to $SSL_DIR"
else
    echo "❌ Certificate directory not found: $CERT_DIR"
    exit 1
fi

# Restart nginx if it was running
if [ "$RESTART_NGINX" = true ]; then
    echo "▶️  Restarting nginx..."
    systemctl start nginx
fi
echo "🔄 Restarting server..."
cd /root/workalong-backend
docker-compose -p workalong -f docker-compose.full.yml restart frontend backend
