
--
-- Name: shifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shifts (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    staff_id bigint NOT NULL,
    shift_date date NOT NULL,
    start_time time without time zone NOT NULL,
    hours numeric(5,2) NOT NULL,
    break_minutes integer DEFAULT 0,
    shift_type text DEFAULT 'regular'::text,
    status text DEFAULT 'scheduled'::text,
    location text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    approved_at timestamp with time zone,
    approved_by bigint,
    time_entry_id bigint,
    clocked_in_time timestamp without time zone,
    clocked_out_time timestamp without time zone,
    pay_type character varying(50) DEFAULT 'regular'::character varying,
    CONSTRAINT positive_hours CHECK ((hours > (0)::numeric)),
    CONSTRAINT valid_break CHECK ((break_minutes >= 0)),
    CONSTRAINT valid_pay_type CHECK (((pay_type)::text = ANY ((ARRAY['regular'::character varying, 'overtime'::character varying, 'on-call'::character varying, 'holiday'::character varying, 'sick'::character varying, 'maternity'::character varying, 'paternity'::character varying, 'unpaid'::character varying, 'training'::character varying, 'other'::character varying])::text[])))
);


--
-- Name: COLUMN shifts.approved_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.shifts.approved_at IS 'When the shift was approved and converted to logged hours';


--
-- Name: COLUMN shifts.approved_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.shifts.approved_by IS 'User who approved the shift';


--
-- Name: COLUMN shifts.time_entry_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.shifts.time_entry_id IS 'The time entry created from this approved shift';


--
-- Name: COLUMN shifts.pay_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.shifts.pay_type IS 'Type of pay for this shift (regular, overtime, holiday, sick, etc.)';


--
-- Name: shifts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shifts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shifts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shifts_id_seq OWNED BY public.shifts.id;


--
-- Name: shifts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts ALTER COLUMN id SET DEFAULT nextval('public.shifts_id_seq'::regclass);


--
-- Name: shifts shifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_pkey PRIMARY KEY (id);


--
-- Name: idx_shifts_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_date ON public.shifts USING btree (shift_date);


--
-- Name: idx_shifts_pay_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_pay_type ON public.shifts USING btree (pay_type);


--
-- Name: idx_shifts_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_staff_id ON public.shifts USING btree (staff_id);


--
-- Name: idx_shifts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_status ON public.shifts USING btree (status);


--
-- Name: idx_shifts_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_user_date ON public.shifts USING btree (user_id, shift_date);


--
-- Name: idx_shifts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_user_id ON public.shifts USING btree (user_id);


--
-- Name: shifts update_shifts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_shifts_updated_at BEFORE UPDATE ON public.shifts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: shifts shifts_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: shifts shifts_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;


--
-- Name: shifts shifts_time_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_time_entry_id_fkey FOREIGN KEY (time_entry_id) REFERENCES public.time_entries(id) ON DELETE SET NULL;


--
-- Name: shifts shifts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


