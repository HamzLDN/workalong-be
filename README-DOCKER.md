# Docker Setup - Workalong

## Architecture

The application runs in **3 Docker containers**:

1. **PostgreSQL** (`workalong-postgres`)
   - Database container with all your data migrated
   - Port: 5432

2. **Backend** (`workalong-backend`)
   - Node.js/Express API server
   - Ports: 8080 (HTTP), 8443 (HTTPS)
   - Connects to PostgreSQL container

3. **Frontend** (`workalong-frontend`)
   - **Nginx** web server serving **React static files**
   - Ports: 80 (HTTP), 443 (HTTPS)
   - Proxies `/api` requests to backend

## Important: Frontend Architecture

**The frontend is NOT running React directly** - it's a **production build**:
- React app is **built** into static files (HTML, JS, CSS)
- Nginx serves these static files
- This is the standard production setup

### To update the frontend:

1. **Build the React app:**
   ```bash
   cd workalong
   npm run build
   ```

2. **Rebuild the frontend container:**
   ```bash
   cd workalong-backend
   docker-compose -f docker-compose.full.yml build frontend
   docker-compose -f docker-compose.full.yml up -d frontend
   ```

## Running Everything

```bash
cd workalong-backend
docker-compose -f docker-compose.full.yml up -d
```

## Access

- **Frontend**: http://localhost/ or https://localhost/
- **Backend API**: http://localhost:8080/api
- **PostgreSQL**: localhost:5432

## Development vs Production

- **Development**: Run `npm run dev` in `workalong/` (React dev server on port 3000)
- **Production**: Use Docker containers (Nginx serving built React files)
