-- Sick leave manual entries + employer payroll preferences (annual leave budget, pension %).
ALTER TABLE public.time_entries
  DROP CONSTRAINT IF EXISTS time_entries_leave_category_check;

ALTER TABLE public.time_entries
  ADD CONSTRAINT time_entries_leave_category_check
  CHECK (
    leave_category = ANY (
      ARRAY['none'::text, 'paid_leave'::text, 'unpaid_leave'::text, 'sick_leave'::text]
    )
  );

COMMENT ON COLUMN public.time_entries.leave_category IS
  'Manual/approved_shift: none=regular; paid_leave=holiday at pay; unpaid_leave=tracked no pay; sick_leave=sick recorded at contractual/staff hourly rate (not HMRC SSP maths).';

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS annual_leave_hours_target numeric(8, 2);

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS pension_employee_percent numeric(6, 2);

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS pension_employer_percent numeric(6, 2);

UPDATE public.users
SET annual_leave_hours_target = 150
WHERE annual_leave_hours_target IS NULL;

UPDATE public.users
SET pension_employee_percent = 5
WHERE pension_employee_percent IS NULL;

UPDATE public.users
SET pension_employer_percent = 3
WHERE pension_employer_percent IS NULL;

ALTER TABLE public.users
  ALTER COLUMN annual_leave_hours_target SET DEFAULT 150;

ALTER TABLE public.users
  ALTER COLUMN pension_employee_percent SET DEFAULT 5;

ALTER TABLE public.users
  ALTER COLUMN pension_employer_percent SET DEFAULT 3;

ALTER TABLE public.users
  ALTER COLUMN annual_leave_hours_target SET NOT NULL;

ALTER TABLE public.users
  ALTER COLUMN pension_employee_percent SET NOT NULL;

ALTER TABLE public.users
  ALTER COLUMN pension_employer_percent SET NOT NULL;

COMMENT ON COLUMN public.users.annual_leave_hours_target IS
  'Paid annual leave hours per year for tracking vs logged paid_leave (employer sets contract equivalent).';

COMMENT ON COLUMN public.users.pension_employee_percent IS
  'Default employee pension contribution % of pay for estimates (auto-enrolment-style).';

COMMENT ON COLUMN public.users.pension_employer_percent IS
  'Default employer pension contribution % of pay for estimates.';
