-- Staff face profiles for kiosk face verification (simple face hash MVP)

CREATE TABLE IF NOT EXISTS public.staff_face_profiles (
  id bigserial PRIMARY KEY,
  staff_id bigint NOT NULL UNIQUE REFERENCES public.staff(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  face_hashes jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_enabled boolean NOT NULL DEFAULT TRUE,
  enrolled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_face_profiles_user_id
  ON public.staff_face_profiles(user_id);

COMMENT ON TABLE public.staff_face_profiles IS
  'Stores kiosk face hash templates for staff clock-in/out verification.';

COMMENT ON COLUMN public.staff_face_profiles.face_hashes IS
  'Array of perceptual face hashes captured from kiosk camera.';
