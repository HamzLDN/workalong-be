# Maintenance Mode Guide

This guide explains how to put your website into maintenance mode when running in Docker.

## Quick Start

### Enable Maintenance Mode
```bash
cd workalong-backend
./enable-maintenance.sh
```

### Disable Maintenance Mode
```bash
cd workalong-backend
./disable-maintenance.sh
```

## How It Works

1. **Maintenance Flag**: The system uses a flag file (`/var/www/maintenance/maintenance.flag`) inside the frontend container
2. **Nginx Check**: Nginx checks for this flag file on every request
3. **Maintenance Page**: If the flag exists, visitors see a maintenance page instead of your website
4. **API Access**: The `/api` endpoints remain accessible (useful for testing)

## What Happens

- ✅ **Frontend**: Shows a professional maintenance page
- ✅ **API**: Still accessible at `/api/*` endpoints
- ✅ **Health Check**: Still responds at `/health`
- ✅ **No Downtime**: No need to stop containers

## After Enabling Maintenance Mode

After running `enable-maintenance.sh`, you need to **rebuild the frontend container** for the changes to take effect:

```bash
# Rebuild and restart the frontend container
cd workalong-backend
docker-compose -f docker-compose.full.yml up -d --build frontend
```

## Customizing the Maintenance Page

Edit the maintenance page:
```bash
# Edit the maintenance HTML
nano docker/maintenance.html
```

Then rebuild the frontend:
```bash
cd workalong-backend
docker-compose -f docker-compose.full.yml up -d --build frontend
```

## Manual Method (Alternative)

If you prefer to do it manually:

### Enable:
```bash
docker exec workalong-frontend mkdir -p /var/www/maintenance
docker exec workalong-frontend touch /var/www/maintenance/maintenance.flag
docker exec workalong-frontend nginx -s reload
```

### Disable:
```bash
docker exec workalong-frontend rm -f /var/www/maintenance/maintenance.flag
docker exec workalong-frontend nginx -s reload
```

## Important Notes

- ⚠️ **First Time**: After adding maintenance mode support, you must rebuild the frontend container
- ⚠️ **API Access**: API endpoints are NOT blocked during maintenance (by design)
- ⚠️ **Health Checks**: Health check endpoints remain accessible
- ✅ **No Data Loss**: Enabling maintenance mode doesn't affect your database or backend

## Troubleshooting

**Maintenance page not showing?**
1. Make sure you've rebuilt the frontend container after adding maintenance mode
2. Check if the flag file exists: `docker exec workalong-frontend ls -la /var/www/maintenance/`
3. Check nginx logs: `docker logs workalong-frontend`

**Want to test without affecting users?**
- Use a staging environment first
- Or test locally before deploying

