-- Per-employer workspace hostname: {workspace_slug}.workalong.co.uk
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS workspace_slug text;

CREATE UNIQUE INDEX IF NOT EXISTS users_workspace_slug_key
  ON public.users (workspace_slug)
  WHERE workspace_slug IS NOT NULL;

COMMENT ON COLUMN public.users.workspace_slug IS
  'Unique DNS label for employer dashboard (e.g. acme → acme.workalong.co.uk).';
