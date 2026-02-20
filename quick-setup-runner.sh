#!/bin/bash
# Quick setup - paste your token when prompted

cd /root/actions-runner || (mkdir -p /root/actions-runner && cd /root/actions-runner)

# Clean up if exists
if [ -f "./config.sh" ]; then
    sudo ./svc.sh stop 2>/dev/null || true
    sudo ./svc.sh uninstall 2>/dev/null || true
    cd /root && rm -rf actions-runner && mkdir -p actions-runner && cd actions-runner
fi

echo "Downloading runner..."
curl -o actions-runner-linux-x64-2.331.0.tar.gz -L https://github.com/actions/runner/releases/download/v2.331.0/actions-runner-linux-x64-2.331.0.tar.gz

echo "Extracting..."
tar xzf ./actions-runner-linux-x64-2.331.0.tar.gz
rm ./actions-runner-linux-x64-2.331.0.tar.gz

echo ""
echo "Paste your registration token from GitHub:"
echo "https://github.com/HamzLDN/workalong-be/settings/actions/runners/new"
read -p "Token: " TOKEN

echo "Configuring..."
RUNNER_ALLOW_RUNASROOT=1 ./config.sh --url https://github.com/HamzLDN/workalong-be --token "$TOKEN"

echo "Installing service..."
sudo ./svc.sh install
sudo ./svc.sh start

echo "✅ Done! Check status with: sudo systemctl status actions.runner.*.service"




