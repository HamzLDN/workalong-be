
--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id integer NOT NULL,
    key_name character varying(255) NOT NULL,
    api_key_hash character varying(255) NOT NULL,
    api_key_prefix character varying(20) NOT NULL,
    is_active boolean DEFAULT true,
    last_used_at timestamp without time zone,
    expires_at timestamp without time zone,
    allowed_ips text[],
    allowed_endpoints text[],
    rate_limit_per_minute integer DEFAULT 60,
    rate_limit_per_hour integer DEFAULT 1000,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: api_keys api_keys_api_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_api_key_hash_key UNIQUE (api_key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: api_keys unique_user_key_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT unique_user_key_name UNIQUE (user_id, key_name);


--
-- Name: idx_api_keys_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_active ON public.api_keys USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_api_keys_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_expires ON public.api_keys USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: idx_api_keys_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_hash ON public.api_keys USING btree (api_key_hash);


--
-- Name: idx_api_keys_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_user_id ON public.api_keys USING btree (user_id);


--
-- Name: api_keys api_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


