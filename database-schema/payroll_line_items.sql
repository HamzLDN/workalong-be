
--
-- Name: payroll_line_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_line_items (
    id bigint NOT NULL,
    payroll_record_id bigint NOT NULL,
    staff_id bigint NOT NULL,
    regular_hours numeric(10,2) NOT NULL,
    overtime_hours numeric(10,2) DEFAULT 0,
    hourly_rate numeric(10,2) NOT NULL,
    regular_pay numeric(12,2) NOT NULL,
    overtime_pay numeric(12,2) DEFAULT 0,
    total_pay numeric(12,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: payroll_line_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payroll_line_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payroll_line_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payroll_line_items_id_seq OWNED BY public.payroll_line_items.id;


--
-- Name: payroll_line_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_line_items ALTER COLUMN id SET DEFAULT nextval('public.payroll_line_items_id_seq'::regclass);


--
-- Name: payroll_line_items payroll_line_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_line_items
    ADD CONSTRAINT payroll_line_items_pkey PRIMARY KEY (id);


--
-- Name: idx_payroll_line_items_payroll_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_line_items_payroll_id ON public.payroll_line_items USING btree (payroll_record_id);


--
-- Name: payroll_line_items payroll_line_items_payroll_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_line_items
    ADD CONSTRAINT payroll_line_items_payroll_record_id_fkey FOREIGN KEY (payroll_record_id) REFERENCES public.payroll_records(id) ON DELETE CASCADE;


--
-- Name: payroll_line_items payroll_line_items_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_line_items
    ADD CONSTRAINT payroll_line_items_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


