
--
-- Name: staff_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_sessions (
    id uuid NOT NULL,
    staff_id bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    ip_address text,
    user_agent text
);


--
-- Name: staff_sessions staff_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_sessions
    ADD CONSTRAINT staff_sessions_pkey PRIMARY KEY (id);


--
-- Name: idx_staff_sessions_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_sessions_expires ON public.staff_sessions USING btree (expires_at);


--
-- Name: idx_staff_sessions_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_sessions_staff_id ON public.staff_sessions USING btree (staff_id);


--
-- Name: staff_sessions staff_sessions_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_sessions
    ADD CONSTRAINT staff_sessions_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


