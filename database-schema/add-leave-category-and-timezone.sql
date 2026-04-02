-- Paid / unpaid leave on manual time entries + account timezone (IANA)
-- Run against your Workalong DB after backup.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS timezone text;

COMMENT ON COLUMN public.users.timezone IS 'IANA timezone for schedules and dates (e.g. Europe/London). NULL = use browser offset only.';

ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS leave_category text NOT NULL DEFAULT 'none';

ALTER TABLE public.time_entries
  DROP CONSTRAINT IF EXISTS time_entries_leave_category_check;

ALTER TABLE public.time_entries
  ADD CONSTRAINT time_entries_leave_category_check
  CHECK (leave_category = ANY (ARRAY['none'::text, 'paid_leave'::text, 'unpaid_leave'::text]));

COMMENT ON COLUMN public.time_entries.leave_category IS 'For entry_type manual: none=regular hours, paid_leave=paid at hourly rate, unpaid_leave=tracked but not paid.';
