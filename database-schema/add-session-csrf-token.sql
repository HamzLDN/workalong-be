ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS csrf_token TEXT;

UPDATE public.sessions
SET csrf_token = md5(random()::text || id::text || clock_timestamp()::text) ||
                 md5(random()::text || clock_timestamp()::text || id::text)
WHERE csrf_token IS NULL;
