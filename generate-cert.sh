#!/bin/bash
# Generate self-signed SSL certificates for local development

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SSL_DIR="$SCRIPT_DIR/../workalong-frontend/docker/ssl"

echo "🔐 Generating self-signed SSL certificates for local development..."
echo "📁 Certificate directory: $SSL_DIR"

mkdir -p "$SSL_DIR"

# Generate private key
openssl genrsa -out "$SSL_DIR/privkey.pem" 2048

# Generate certificate signing request
openssl req -new -key "$SSL_DIR/privkey.pem" -out "$SSL_DIR/cert.csr" \
  -subj "/C=US/ST=State/L=City/O=Workalong/CN=localhost"

# Generate self-signed certificate (valid for 365 days)
openssl x509 -req -days 365 -in "$SSL_DIR/cert.csr" -signkey "$SSL_DIR/privkey.pem" \
  -out "$SSL_DIR/fullchain.pem"

# Clean up CSR
rm "$SSL_DIR/cert.csr"

# Set permissions
chmod 600 "$SSL_DIR/privkey.pem"
chmod 644 "$SSL_DIR/fullchain.pem"

echo "✅ SSL certificates generated successfully!"
echo "   Private key: $SSL_DIR/privkey.pem"
echo "   Certificate: $SSL_DIR/fullchain.pem"
echo ""
echo "⚠️  These are self-signed certificates for development only."
echo "   Your browser will show a security warning - this is normal."
echo "   Click 'Advanced' → 'Proceed to localhost' to continue."

