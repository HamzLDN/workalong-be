-- time_entries: leave_category, approvals, sick_leave check (order: column+check → approvals → widen check)

ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS leave_category text NOT NULL DEFAULT 'none';

ALTER TABLE public.time_entries DROP CONSTRAINT IF EXISTS time_entries_leave_category_check;
ALTER TABLE public.time_entries
  ADD CONSTRAINT time_entries_leave_category_check
  CHECK (leave_category = ANY (ARRAY['none'::text, 'paid_leave'::text, 'unpaid_leave'::text]));

ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS approved_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS approved_by bigint REFERENCES public.users(id);

CREATE INDEX IF NOT EXISTS idx_time_entries_approved_at ON public.time_entries(approved_at) WHERE approved_at IS NOT NULL;

UPDATE public.time_entries te
SET approved_at = sh.approved_at, approved_by = sh.approved_by
FROM public.shifts sh
WHERE te.shift_id = sh.id
  AND sh.status = 'approved' AND sh.approved_at IS NOT NULL
  AND te.entry_type = 'clock_in_out'
  AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
  AND te.approved_at IS NULL;

ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS staff_approved_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS staff_approved_by bigint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_staff_approved_by_fkey'
  ) THEN
    ALTER TABLE public.time_entries
      ADD CONSTRAINT time_entries_staff_approved_by_fkey
      FOREIGN KEY (staff_approved_by) REFERENCES public.staff(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_time_entries_staff_approved_pending
  ON public.time_entries(staff_approved_at)
  WHERE staff_approved_at IS NOT NULL AND approved_at IS NULL;

ALTER TABLE public.time_entries DROP CONSTRAINT IF EXISTS time_entries_leave_category_check;
ALTER TABLE public.time_entries
  ADD CONSTRAINT time_entries_leave_category_check
  CHECK (
    leave_category = ANY (
      ARRAY['none'::text, 'paid_leave'::text, 'unpaid_leave'::text, 'sick_leave'::text]
    )
  );
