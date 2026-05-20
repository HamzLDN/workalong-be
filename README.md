# Workalong Backend

Node.js API for Workalong — auth, staff, shifts, clock-in, payments (Stripe), and PostgreSQL.

## Prerequisites

- **Node.js 20+** (local development)
- **Docker** (production / server)
- Copy `.env.example` to `.env` and set database credentials, `SESSION_SECRET`, and Stripe keys as needed

## Local development

```bash
npm install
npm run dev
```

API: `http://localhost:8081/api`  
Health: `http://localhost:8081/api/health`

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server with nodemon (obfuscation off) |
| `npm run dev:secure` | Dev server with obfuscation on |
| `npm test` | Jest tests |

Run PostgreSQL locally (or use `docker compose -f docker-compose.mock.yml up` for a mock DB).

## Production (Docker)

The API runs in Docker on the server — not via `npm start`.

**Full stack** (Postgres + backend + frontend + related services), from this repo:

```bash
docker compose -f docker-compose.full.yml up -d --build
```

**Backend only** (expects an existing Postgres on the `workalong-backend_workalong-network` network):

```bash
docker compose up -d --build
```

Image: `Dockerfile.backend.ubuntu` · API port **8080** · health: `http://localhost:8080/api/health`

Set secrets in `.env` before `docker compose` (Stripe, `SESSION_SECRET`, etc.). `docker-compose.full.yml` loads `.env` via `env_file`.

## Layout

```
index.js          # Express app entry
routes/           # HTTP routes
services/         # Business logic
middleware/       # Auth, security, obfuscation
lib/              # Config, DB pool, helpers
```

## With the frontend

**Dev:** run this API, then `npm run dev` in `workalong-frontend` (frontend proxies `/api` here).

**Prod:** use `docker-compose.full.yml` so nginx in the frontend container serves the app and proxies `/api` to this backend.
