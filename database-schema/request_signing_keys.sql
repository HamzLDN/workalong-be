
--
-- Name: request_signing_keys; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: request_signing_keys request_signing_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_signing_keys
    ADD CONSTRAINT request_signing_keys_pkey PRIMARY KEY (id);


--
-- Name: request_signing_keys request_signing_keys_signing_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_signing_keys
    ADD CONSTRAINT request_signing_keys_signing_key_hash_key UNIQUE (signing_key_hash);


--
-- Name: request_signing_keys unique_user_signing_key_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_signing_keys
    ADD CONSTRAINT unique_user_signing_key_name UNIQUE (user_id, key_name);


--
-- Name: idx_signing_keys_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_signing_keys_active ON public.request_signing_keys USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_signing_keys_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_signing_keys_hash ON public.request_signing_keys USING btree (signing_key_hash);


--
-- Name: idx_signing_keys_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_signing_keys_user_id ON public.request_signing_keys USING btree (user_id);


--
-- Name: request_signing_keys request_signing_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_signing_keys
    ADD CONSTRAINT request_signing_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


