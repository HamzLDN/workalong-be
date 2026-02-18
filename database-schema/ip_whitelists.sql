
--
-- Name: ip_whitelists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ip_whitelists (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id integer,
    ip_address character varying(45) NOT NULL,
    cidr_block character varying(18),
    description text,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: ip_whitelists ip_whitelists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ip_whitelists
    ADD CONSTRAINT ip_whitelists_pkey PRIMARY KEY (id);


--
-- Name: ip_whitelists unique_user_ip; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ip_whitelists
    ADD CONSTRAINT unique_user_ip UNIQUE (user_id, ip_address);


--
-- Name: idx_ip_whitelists_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ip_whitelists_active ON public.ip_whitelists USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_ip_whitelists_ip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ip_whitelists_ip ON public.ip_whitelists USING btree (ip_address);


--
-- Name: idx_ip_whitelists_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ip_whitelists_user_id ON public.ip_whitelists USING btree (user_id);


--
-- Name: ip_whitelists ip_whitelists_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ip_whitelists
    ADD CONSTRAINT ip_whitelists_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


