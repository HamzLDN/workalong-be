-- Rotating CSRF tokens for employer browser sessions (stored per row, not derived from SESSION_SECRET).
-- Fresh installs: use database-schema/sessions.sql (includes csrf_token).
-- Existing DBs: run after backup — psql "$DATABASE_URL" -f database-schema/add-session-csrf-token.sql

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS csrf_token TEXT;

COMMENT ON COLUMN public.sessions.csrf_token IS 'Rotating browser CSRF secret; replaced after each successful X-CSRF-Token validation. GET /api/auth/csrf-token returns current value without consuming it.';

-- Backfill rows that predate this column (invalidates old client-side hash tokens until next GET /api/auth/csrf-token)
UPDATE public.sessions
SET csrf_token = md5(random()::text || id::text || clock_timestamp()::text) ||
                 md5(random()::text || clock_timestamp()::text || id::text)
WHERE csrf_token IS NULL;
