# Setting Up GitHub Actions Self-Hosted Runner

This allows GitHub Actions to run directly on your server, giving it access to `localhost:8081` without SSH tunneling.

## Steps:

1. **Go to your GitHub repository** → Settings → Actions → Runners

2. **Click "New self-hosted runner"**

3. **Select Linux** and copy the commands shown

4. **On your server, run these commands:**
   ```bash
   cd /root/workalong-backend
   
   # Download and configure the runner (use the commands from GitHub)
   # Example:
   mkdir -p actions-runner && cd actions-runner
   curl -o actions-runner-linux-x64-2.311.0.tar.gz -L https://github.com/actions/runner/releases/download/v2.311.0/actions-runner-linux-x64-2.311.0.tar.gz
   tar xzf ./actions-runner-linux-x64-2.311.0.tar.gz
   
   # Configure (use the token from GitHub)
   ./config.sh --url https://github.com/YOUR_USERNAME/workalong-backend --token YOUR_TOKEN
   
   # Install as a service
   sudo ./svc.sh install
   sudo ./svc.sh start
   ```

5. **The runner will now appear in your GitHub repository** and workflows using `runs-on: self-hosted` will run on your server.

## Alternative: Test After Deployment

If you don't want to set up a self-hosted runner, you can test the deployed version instead:

1. Deploy first
2. Test against the deployed endpoint (e.g., `http://your-server:8080/api`)
3. Rollback if tests fail

This approach is simpler but tests the deployed version rather than pre-deployment.


