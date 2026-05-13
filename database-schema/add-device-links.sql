CREATE TABLE IF NOT EXISTS public.device_links (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id bigint NOT NULL,
  staff_id bigint,
  link_token character varying(64) NOT NULL,
  device_fingerprint text,
  device_name text,
  created_at timestamp with time zone DEFAULT now(),
  expires_at timestamp with time zone,
  is_active boolean DEFAULT true,
  last_used_at timestamp with time zone
);

DO $$
BEGIN
  ALTER TABLE ONLY public.device_links ADD CONSTRAINT device_links_pkey PRIMARY KEY (id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN invalid_table_definition THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE ONLY public.device_links ADD CONSTRAINT device_links_link_token_key UNIQUE (link_token);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_device_links_fingerprint ON public.device_links USING btree (device_fingerprint);
CREATE INDEX IF NOT EXISTS idx_device_links_staff_id ON public.device_links USING btree (staff_id);
CREATE INDEX IF NOT EXISTS idx_device_links_token ON public.device_links USING btree (link_token);
CREATE INDEX IF NOT EXISTS idx_device_links_user_id ON public.device_links USING btree (user_id);

DO $$
BEGIN
  ALTER TABLE ONLY public.device_links
    ADD CONSTRAINT device_links_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE ONLY public.device_links
    ADD CONSTRAINT device_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
