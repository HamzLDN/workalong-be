CREATE TABLE public.request_signing_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id integer NOT NULL,
    key_name character varying(255) NOT NULL,
    signing_key_hash character varying(255) NOT NULL,
    signing_key_prefix character varying(20) NOT NULL,
    is_active boolean DEFAULT true,
    last_used_at timestamp without time zone,
    expires_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);

ALTER TABLE ONLY public.request_signing_keys
    ADD CONSTRAINT request_signing_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.request_signing_keys
    ADD CONSTRAINT request_signing_keys_signing_key_hash_key UNIQUE (signing_key_hash);

ALTER TABLE ONLY public.request_signing_keys
    ADD CONSTRAINT unique_user_signing_key_name UNIQUE (user_id, key_name);

CREATE INDEX idx_signing_keys_active ON public.request_signing_keys USING btree (is_active) WHERE (is_active = true);

CREATE INDEX idx_signing_keys_hash ON public.request_signing_keys USING btree (signing_key_hash);

CREATE INDEX idx_signing_keys_user_id ON public.request_signing_keys USING btree (user_id);

ALTER TABLE ONLY public.request_signing_keys
    ADD CONSTRAINT request_signing_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
