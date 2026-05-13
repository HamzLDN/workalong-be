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

CREATE SEQUENCE public.payroll_line_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.payroll_line_items_id_seq OWNED BY public.payroll_line_items.id;

ALTER TABLE ONLY public.payroll_line_items ALTER COLUMN id SET DEFAULT nextval('public.payroll_line_items_id_seq'::regclass);

ALTER TABLE ONLY public.payroll_line_items
    ADD CONSTRAINT payroll_line_items_pkey PRIMARY KEY (id);

CREATE INDEX idx_payroll_line_items_payroll_id ON public.payroll_line_items USING btree (payroll_record_id);

ALTER TABLE ONLY public.payroll_line_items
    ADD CONSTRAINT payroll_line_items_payroll_record_id_fkey FOREIGN KEY (payroll_record_id) REFERENCES public.payroll_records(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.payroll_line_items
    ADD CONSTRAINT payroll_line_items_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;
