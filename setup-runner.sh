#!/bin/bash

# GitHub Actions Self-Hosted Runner Setup Script
set -e

echo "=========================================="
echo "GitHub Actions Self-Hosted Runner Setup"
echo "=========================================="
echo ""

# Get repository URL
REPO_URL="https://github.com/HamzLDN/workalong-be"
echo "Repository: $REPO_URL"
echo ""
echo "=========================================="
echo "Get your registration token from GitHub:"
echo "1. Go to: $REPO_URL/settings/actions/runners/new"
echo "2. Select 'Linux' as the runner type"
echo "3. Copy the registration token shown"
echo "=========================================="
echo ""
read -p "Paste your registration token here: " REGISTRATION_TOKEN

if [ -z "$REGISTRATION_TOKEN" ]; then
    echo "❌ Registration token is required"
    exit 1
fi

# Install under /root/actions/<label> (not inside the git repo; avoids clutter).
RUNNER_DIR="/root/actions/workalong-backend"
echo ""
echo "Setting up runner in: $RUNNER_DIR"

# Remove existing runner if it exists
if [ -d "$RUNNER_DIR" ]; then
    echo "⚠️  Existing runner directory found. Removing..."
    cd "$RUNNER_DIR"
    if [ -f "./svc.sh" ]; then
        echo "Stopping existing service..."
        sudo ./svc.sh stop || true
        sudo ./svc.sh uninstall || true
    fi
    cd ..
    rm -rf "$RUNNER_DIR"
fi

# Create directory and download runner
mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

echo "Downloading runner..."
RUNNER_VERSION="2.331.0"
RUNNER_FILE="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
RUNNER_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_FILE}"

curl -o "$RUNNER_FILE" -L "$RUNNER_URL"

echo "Extracting runner..."
tar xzf "./$RUNNER_FILE"
rm "./$RUNNER_FILE"

echo "Configuring runner..."
./config.sh --url "$REPO_URL" --token "$REGISTRATION_TOKEN"

echo ""
echo "Installing as a systemd service..."
sudo ./svc.sh install
sudo ./svc.sh start

echo ""
echo "=========================================="
echo "✅ Self-hosted runner setup complete!"
echo "=========================================="
echo ""
echo "The runner is now installed as a systemd service."
echo "It will automatically start on boot and pick up jobs from GitHub."
echo ""
echo "To check runner status:"
echo "  sudo systemctl status actions.runner.*.service"
echo ""
echo "To view runner logs:"
echo "  sudo journalctl -u actions.runner.*.service -f"
echo ""
echo "To stop the runner:"
echo "  cd $RUNNER_DIR && sudo ./svc.sh stop"
echo ""
echo "To uninstall the runner:"
echo "  cd $RUNNER_DIR && sudo ./svc.sh uninstall && cd .. && rm -rf $RUNNER_DIR"
echo ""
