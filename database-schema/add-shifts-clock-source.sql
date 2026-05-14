ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS clock_source text DEFAULT 'staff'::text;

COMMENT ON COLUMN public.shifts.clock_source IS 'Whether clock times came from staff (portal/kiosk) or manager-adjusted workflows (e.g. manager).';
