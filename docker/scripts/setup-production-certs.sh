#!/bin/bash
# Script to set up production SSL certificates on the server
# This script helps copy your existing certificates to the correct location

set -e

BACKEND_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SSL_DIR="$BACKEND_ROOT/../workalong-frontend/docker/ssl"

echo "🔐 Setting up production SSL certificates"
echo "📁 Target directory: $SSL_DIR"
echo ""

# Create SSL directory if it doesn't exist
mkdir -p "$SSL_DIR"

# Check if certificates already exist
if [ -f "$SSL_DIR/fullchain.pem" ] && [ -f "$SSL_DIR/privkey.pem" ]; then
    echo "⚠️  Certificates already exist in $SSL_DIR"
    read -p "Do you want to replace them? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing certificates."
        exit 0
    fi
fi

echo ""
echo "Where are your production certificates located?"
echo "1. Let's Encrypt (/etc/letsencrypt/live/workalong.co.uk/)"
echo "2. Custom path (enter manually)"
echo "3. Skip (certificates already in place)"
read -p "Choose option (1-3): " -n 1 -r
echo

case $REPLY in
    1)
        LETSENCRYPT_DIR="/etc/letsencrypt/live/workalong.co.uk"
        if [ ! -d "$LETSENCRYPT_DIR" ]; then
            echo "❌ Let's Encrypt directory not found: $LETSENCRYPT_DIR"
            exit 1
        fi
        
        echo "📋 Copying Let's Encrypt certificates..."
        sudo cp "$LETSENCRYPT_DIR/fullchain.pem" "$SSL_DIR/fullchain.pem"
        sudo cp "$LETSENCRYPT_DIR/privkey.pem" "$SSL_DIR/privkey.pem"
        sudo chmod 644 "$SSL_DIR/fullchain.pem"
        sudo chmod 600 "$SSL_DIR/privkey.pem"
        sudo chown $(whoami):$(whoami) "$SSL_DIR"/*.pem 2>/dev/null || true
        echo "✅ Certificates copied successfully!"
        ;;
    2)
        read -p "Enter path to fullchain.pem: " CERT_PATH
        read -p "Enter path to privkey.pem: " KEY_PATH
        
        if [ ! -f "$CERT_PATH" ] || [ ! -f "$KEY_PATH" ]; then
            echo "❌ Certificate files not found!"
            exit 1
        fi
        
        echo "📋 Copying certificates..."
        cp "$CERT_PATH" "$SSL_DIR/fullchain.pem"
        cp "$KEY_PATH" "$SSL_DIR/privkey.pem"
        chmod 644 "$SSL_DIR/fullchain.pem"
        chmod 600 "$SSL_DIR/privkey.pem"
        echo "✅ Certificates copied successfully!"
        ;;
    3)
        echo "Skipping certificate setup."
        ;;
    *)
        echo "Invalid option. Exiting."
        exit 1
        ;;
esac

echo ""
echo "📋 Certificate setup complete!"
echo ""
echo "Next steps:"
echo "1. Restart the containers:"
echo "   cd workalong-backend && docker-compose -f docker-compose.full.yml restart frontend backend"
echo ""
echo "2. Verify HTTPS is working:"
echo "   curl -I https://workalong.co.uk"
echo ""
echo "The system will automatically:"
echo "  ✅ Use production certificates if present in $SSL_DIR"
echo "  ✅ Fall back to self-signed dev certificates if not"
echo "  ✅ Enable HTTPS automatically when certificates are detected"

