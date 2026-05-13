CREATE TABLE public.ip_whitelists (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id integer,
    ip_address character varying(45) NOT NULL,
    cidr_block character varying(18),
    description text,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now()
);

ALTER TABLE ONLY public.ip_whitelists
    ADD CONSTRAINT ip_whitelists_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ip_whitelists
    ADD CONSTRAINT unique_user_ip UNIQUE (user_id, ip_address);

CREATE INDEX idx_ip_whitelists_active ON public.ip_whitelists USING btree (is_active) WHERE (is_active = true);

CREATE INDEX idx_ip_whitelists_ip ON public.ip_whitelists USING btree (ip_address);

CREATE INDEX idx_ip_whitelists_user_id ON public.ip_whitelists USING btree (user_id);

ALTER TABLE ONLY public.ip_whitelists
    ADD CONSTRAINT ip_whitelists_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
