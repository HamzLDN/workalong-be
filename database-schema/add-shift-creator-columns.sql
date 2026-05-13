ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS created_by_user_id bigint REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS created_by_staff_id bigint REFERENCES public.staff(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_shifts_created_by_user_id ON public.shifts(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_shifts_created_by_staff_id ON public.shifts(created_by_staff_id);
