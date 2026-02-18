
--
-- Name: shift_swaps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shift_swaps (
    id bigint NOT NULL,
    shift_id bigint NOT NULL,
    requester_staff_id bigint NOT NULL,
    target_staff_id bigint,
    status text DEFAULT 'pending'::text,
    message text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: shift_swaps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shift_swaps_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shift_swaps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shift_swaps_id_seq OWNED BY public.shift_swaps.id;


--
-- Name: shift_swaps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_swaps ALTER COLUMN id SET DEFAULT nextval('public.shift_swaps_id_seq'::regclass);


--
-- Name: shift_swaps shift_swaps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_swaps
    ADD CONSTRAINT shift_swaps_pkey PRIMARY KEY (id);


--
-- Name: idx_shift_swaps_requester; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shift_swaps_requester ON public.shift_swaps USING btree (requester_staff_id);


--
-- Name: idx_shift_swaps_shift_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shift_swaps_shift_id ON public.shift_swaps USING btree (shift_id);


--
-- Name: idx_shift_swaps_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shift_swaps_status ON public.shift_swaps USING btree (status);


--
-- Name: shift_swaps shift_swaps_requester_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_swaps
    ADD CONSTRAINT shift_swaps_requester_staff_id_fkey FOREIGN KEY (requester_staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;


--
-- Name: shift_swaps shift_swaps_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_swaps
    ADD CONSTRAINT shift_swaps_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.shifts(id) ON DELETE CASCADE;


--
-- Name: shift_swaps shift_swaps_target_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_swaps
    ADD CONSTRAINT shift_swaps_target_staff_id_fkey FOREIGN KEY (target_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--


