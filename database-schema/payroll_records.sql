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

CREATE SEQUENCE public.payroll_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.payroll_records_id_seq OWNED BY public.payroll_records.id;

ALTER TABLE ONLY public.payroll_records ALTER COLUMN id SET DEFAULT nextval('public.payroll_records_id_seq'::regclass);

ALTER TABLE ONLY public.payroll_records
    ADD CONSTRAINT payroll_records_pkey PRIMARY KEY (id);

CREATE INDEX idx_payroll_records_user_id ON public.payroll_records USING btree (user_id);

CREATE TRIGGER update_payroll_records_updated_at BEFORE UPDATE ON public.payroll_records FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE ONLY public.payroll_records
    ADD CONSTRAINT payroll_records_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
