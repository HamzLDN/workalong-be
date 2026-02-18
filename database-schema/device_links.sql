
--
-- Name: device_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_links (
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


--
-- Name: TABLE device_links; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.device_links IS 'Device-specific links for clock-in/clock-out kiosk system. Each link is tied to a specific device/PC. Multiple staff can use the same device link with their 6-digit IDs.';


--
-- Name: COLUMN device_links.staff_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.device_links.staff_id IS 'Optional - can be NULL for kiosk mode where multiple staff use the same device';


--
-- Name: COLUMN device_links.link_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.device_links.link_token IS 'Unique token used in the clock-in URL';


--
-- Name: COLUMN device_links.device_fingerprint; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.device_links.device_fingerprint IS 'Browser/device fingerprint to ensure link only works on the intended device. Set to NULL initially, populated on first access.';


--
-- Name: COLUMN device_links.device_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.device_links.device_name IS 'Optional name for the device (e.g., "Office Tablet", "Reception iPad")';


--
-- Name: device_links device_links_link_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_links
    ADD CONSTRAINT device_links_link_token_key UNIQUE (link_token);


--
-- Name: device_links device_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_links
    ADD CONSTRAINT device_links_pkey PRIMARY KEY (id);


--
-- Name: idx_device_links_fingerprint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_links_fingerprint ON public.device_links USING btree (device_fingerprint);


--
-- Name: idx_device_links_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_links_staff_id ON public.device_links USING btree (staff_id);


--
-- Name: idx_device_links_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_links_token ON public.device_links USING btree (link_token);


--
-- Name: idx_device_links_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_links_user_id ON public.device_links USING btree (user_id);


--
-- Name: device_links device_links_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_links
    ADD CONSTRAINT device_links_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;


--
-- Name: device_links device_links_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_links
    ADD CONSTRAINT device_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


