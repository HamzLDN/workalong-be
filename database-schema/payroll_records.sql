
--
-- Name: payroll_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_records (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    total_amount numeric(12,2) NOT NULL,
    total_hours numeric(10,2) NOT NULL,
    status text DEFAULT 'draft'::text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: payroll_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payroll_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payroll_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payroll_records_id_seq OWNED BY public.payroll_records.id;


--
-- Name: payroll_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_records ALTER COLUMN id SET DEFAULT nextval('public.payroll_records_id_seq'::regclass);


--
-- Name: payroll_records payroll_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_records
    ADD CONSTRAINT payroll_records_pkey PRIMARY KEY (id);


--
-- Name: idx_payroll_records_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_records_user_id ON public.payroll_records USING btree (user_id);


--
-- Name: payroll_records update_payroll_records_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_payroll_records_updated_at BEFORE UPDATE ON public.payroll_records FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: payroll_records payroll_records_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_records
    ADD CONSTRAINT payroll_records_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


