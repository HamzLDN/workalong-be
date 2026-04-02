# Backend Docker Deployment Guide

## Pre-Deploy: Ensure Databases Match

Before deploying to production, ensure your main and mock databases have matching schemas:

```bash
# 1. Sync mock from main (if you've run migrations on main)
./docker/scripts/clone-db-to-mock.sh

# 2. Compare schemas - must pass before deploy
npm run db:compare
```

If schemas differ, apply migrations to the main DB first (`npm run migrate:time-entry-approval` etc.), then re-run `docker/scripts/clone-db-to-mock.sh` and `npm run db:compare`.

### Apply migrations to production

Before or during deploy, run migrations against the production database:

```bash
# Set prod DB env vars (or use .env.prod)
export DB_HOST=your-prod-db-host
export DB_PORT=5432
export DB_USER=your-db-user
export DB_PASSWORD=your-db-password
export DB_NAME=users

# Run all migrations (time-entry approval, discount, etc.)
NODE_ENV=production npm run migrate:prod
```

This applies the same schema changes that exist on your local mock: `approved_at`/`approved_by` on `time_entries`, `subscription_discount_percent` on `users`, etc. Migrations are idempotent (safe to run if already applied).

---

## Quick Start

### 0. Push changes (triggers GitHub Actions deploy)

```bash
# Backend
cd workalong-backend
git add -A && git commit -m "Your commit message" && git push origin main

# Frontend (if separate repo)
cd workalong-frontend
git add -A && git commit -m "Your commit message" && git push origin main
```

### 1. Build the Docker Image

```bash
cd /root/workalong-backend
docker build -f Dockerfile.backend.ubuntu -t workalong-backend:latest .
```

### 2. Run with Docker Compose (Recommended)

```bash
# Make sure your .env file is configured
docker-compose up -d
```

### 3. Run Standalone Container

```bash
docker run -d \
  --name workalong-backend \
  --restart unless-stopped \
  -p 8080:8080 \
  -p 3443:3443 \
  -e PORT=8080 \
  -e NODE_ENV=production \
  -e DOCKER=true \
  -e DB_HOST=your-db-host \
  -e DB_PORT=5432 \
  -e DB_USER=your-db-user \
  -e DB_PASSWORD=your-db-password \
  -e DB_NAME=your-db-name \
  -e SESSION_SECRET=your-session-secret \
  -v $(pwd)/certs:/app/certs:ro \
  workalong-backend:latest
```

## Environment Variables

Required environment variables (set in `.env` or docker-compose.yml):

- `DB_HOST` - PostgreSQL host
- `DB_PORT` - PostgreSQL port (default: 5432)
- `DB_USER` - Database user
- `DB_PASSWORD` - Database password
- `DB_NAME` - Database name
- `PORT` - Backend port (default: 8080)
- `NODE_ENV` - Environment (production/development)
- `SESSION_SECRET` - Session encryption secret
- `STRIPE_SECRET_KEY` - (Optional) Stripe secret key
- `STRIPE_PUBLISHABLE_KEY` - (Optional) Stripe publishable key

## Useful Commands

### View logs
```bash
docker logs -f workalong-backend
```

### Stop container
```bash
docker stop workalong-backend
```

### Start container
```bash
docker start workalong-backend
```

### Restart container
```bash
docker restart workalong-backend
```

### Rebuild and restart
```bash
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### Check health
```bash
curl http://localhost:8080/api/health
```

## Troubleshooting

### Container won't start
- Check logs: `docker logs workalong-backend`
- Verify environment variables are set
- Ensure database is accessible from container

### Database connection issues
- Verify `DB_HOST` is correct (use container name if DB is in Docker)
- Check network connectivity
- Verify credentials

### Port conflicts
- Change port mapping in docker-compose.yml: `"8081:8080"`
- Or stop conflicting service





