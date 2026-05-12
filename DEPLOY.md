# Backend Docker Deployment Guide

## Pre-Deploy: Ensure Databases Match

Before deploying to production, ensure your main and mock databases have matching schemas:

```bash
# 1. Sync mock from main (if you've run migrations on main)
./docker/scripts/clone-db-to-mock.sh

# 2. Compare schemas - must pass before deploy (core Workalong tables + shared extras below)
npm run db:compare
```

Schema-only sync on mock:

```bash
DB_HOST=127.0.0.1 DB_PORT=5433 DB_USER=workalong DB_PASSWORD=… DB_NAME=users NODE_ENV=production npm run migrate:prod
npm run db:mock:apply-extras
```

If schemas differ after that, sync data from main (`./docker/scripts/clone-db-to-mock.sh`) or apply missing DDL on main first, then repeat.

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

This applies the same incremental migrations as your mock DB, in order: `subscription_discount_percent` on `users`, `approved_at`/`approved_by` on `time_entries`, `timezone` on `users` and `leave_category` on `time_entries`, **`device_links` (clock-in kiosk links)**, **`staff_face_profiles` (Face ID)**, sessions `csrf_token`, etc. See `scripts/run-migrations-for-prod.js` for the full list. Migrations are idempotent (safe to re-run if already applied).

**Push to `main`** runs GitHub Actions deploy, which builds the image and runs `npm run migrate:prod` against production Postgres before restarting the backend container (`Sync production database schema` in `.github/workflows/main.yml`). Pushes that only change `.sql` files now trigger this workflow (`**/*.sql` in workflow `paths`).

### Mock database: match production layout

Production may also have **admin panel** tables (`admin_passkeys`, `admin_chat_messages`, …), `app_settings`, and **`billing_reminder_log`** (created by the billing reminder helper). Those are not part of `migrate:prod`. After syncing the core schema on mock (`npm run migrate:prod` with `DB_HOST`/`DB_PORT` pointing at mock), run:

```bash
npm run db:mock:apply-extras
```

Then `npm run db:compare` should report main and mock schemas in sync (assuming both received the same extras).

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





