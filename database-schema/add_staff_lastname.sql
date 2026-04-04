-- Optional family name for kiosk / reports (paired with staff.name)
ALTER TABLE public.staff ADD COLUMN IF NOT EXISTS lastname text;

COMMENT ON COLUMN public.staff.lastname IS 'Family name; combined with name for full display (e.g. face identify)';
