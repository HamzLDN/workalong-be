-- users: additive columns (idempotent)

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
        AND column_name = 'subscription_discount_percent'
    ) THEN
        ALTER TABLE public.users
        ADD COLUMN subscription_discount_percent INTEGER CHECK (subscription_discount_percent >= 0 AND subscription_discount_percent <= 100);
    END IF;
END $$;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS timezone text;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS annual_leave_hours_target numeric(8, 2);
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS pension_employee_percent numeric(6, 2);
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS pension_employer_percent numeric(6, 2);

UPDATE public.users SET annual_leave_hours_target = 150 WHERE annual_leave_hours_target IS NULL;
UPDATE public.users SET pension_employee_percent = 5 WHERE pension_employee_percent IS NULL;
UPDATE public.users SET pension_employer_percent = 3 WHERE pension_employer_percent IS NULL;

ALTER TABLE public.users ALTER COLUMN annual_leave_hours_target SET DEFAULT 150;
ALTER TABLE public.users ALTER COLUMN pension_employee_percent SET DEFAULT 5;
ALTER TABLE public.users ALTER COLUMN pension_employer_percent SET DEFAULT 3;
ALTER TABLE public.users ALTER COLUMN annual_leave_hours_target SET NOT NULL;
ALTER TABLE public.users ALTER COLUMN pension_employee_percent SET NOT NULL;
ALTER TABLE public.users ALTER COLUMN pension_employer_percent SET NOT NULL;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS head_office_access boolean NOT NULL DEFAULT true;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS manager_permissions jsonb;
