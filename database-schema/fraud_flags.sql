
--
-- Name: fraud_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fraud_flags (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    staff_id bigint NOT NULL,
    time_entry_id bigint,
    flag_type text NOT NULL,
    severity text DEFAULT 'medium'::text,
    description text NOT NULL,
    is_resolved boolean DEFAULT false,
    resolved_by bigint,
    resolved_at timestamp with time zone,
    resolution_notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: fraud_flags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fraud_flags_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fraud_flags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fraud_flags_id_seq OWNED BY public.fraud_flags.id;


--
-- Name: fraud_flags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fraud_flags ALTER COLUMN id SET DEFAULT nextval('public.fraud_flags_id_seq'::regclass);


--
-- Name: fraud_flags fraud_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fraud_flags
    ADD CONSTRAINT fraud_flags_pkey PRIMARY KEY (id);


--
-- Name: idx_fraud_flags_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fraud_flags_created ON public.fraud_flags USING btree (created_at);


--
-- Name: idx_fraud_flags_resolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fraud_flags_resolved ON public.fraud_flags USING btree (is_resolved);


--
-- Name: idx_fraud_flags_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fraud_flags_staff ON public.fraud_flags USING btree (staff_id);


--
-- Name: idx_fraud_flags_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fraud_flags_staff_id ON public.fraud_flags USING btree (staff_id);


--
-- Name: idx_fraud_flags_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fraud_flags_type ON public.fraud_flags USING btree (flag_type);


--
-- Name: idx_fraud_flags_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fraud_flags_user_id ON public.fraud_flags USING btree (user_id);


--
-- Name: fraud_flags fraud_flags_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fraud_flags
    ADD CONSTRAINT fraud_flags_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: fraud_flags fraud_flags_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fraud_flags
    ADD CONSTRAINT fraud_flags_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;


--
-- Name: fraud_flags fraud_flags_time_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fraud_flags
    ADD CONSTRAINT fraud_flags_time_entry_id_fkey FOREIGN KEY (time_entry_id) REFERENCES public.time_entries(id) ON DELETE CASCADE;


--
-- Name: fraud_flags fraud_flags_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fraud_flags
    ADD CONSTRAINT fraud_flags_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


