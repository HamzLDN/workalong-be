-- 128-D face descriptors (face-api / @vladmandic/face-api), optional upgrade from luminance hashes.

ALTER TABLE public.staff_face_profiles
  ADD COLUMN IF NOT EXISTS face_embeddings jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.staff_face_profiles.face_embeddings IS
  'Array of 128-float face recognition descriptors; when non-empty, kiosk uses embedding match instead of face_hashes.';
