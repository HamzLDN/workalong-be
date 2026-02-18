
--
-- Name: staff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    name text NOT NULL,
    email text,
    role text NOT NULL,
    hourly_rate numeric(10,2) NOT NULL,
    employment_type text DEFAULT 'full-time'::text,
    status text DEFAULT 'active'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    suspicious_pattern_count integer DEFAULT 0,
    last_pattern_check timestamp with time zone,
    username text,
    password_hash text,
    password_set boolean DEFAULT false,
    clockin_id character varying(6)
);


--
-- Name: COLUMN staff.clockin_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff.clockin_id IS 'Unique 6-digit ID for clock-in/clock-out system';


--
-- Name: staff_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_id_seq OWNED BY public.staff.id;


--
-- Name: staff id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff ALTER COLUMN id SET DEFAULT nextval('public.staff_id_seq'::regclass);


--
-- Name: staff staff_clockin_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_clockin_id_key UNIQUE (clockin_id);


--
-- Name: staff staff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_pkey PRIMARY KEY (id);


--
-- Name: staff staff_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_username_key UNIQUE (username);


--
-- Name: idx_staff_clockin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_clockin_id ON public.staff USING btree (clockin_id);


--
-- Name: idx_staff_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_status ON public.staff USING btree (status);


--
-- Name: idx_staff_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_user_id ON public.staff USING btree (user_id);


--
-- Name: idx_staff_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_username ON public.staff USING btree (username);


--
-- Name: staff update_staff_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_staff_updated_at BEFORE UPDATE ON public.staff FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: staff staff_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


