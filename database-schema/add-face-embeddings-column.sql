ALTER TABLE public.staff_face_profiles
  ADD COLUMN IF NOT EXISTS face_embeddings jsonb NOT NULL DEFAULT '[]'::jsonb;
