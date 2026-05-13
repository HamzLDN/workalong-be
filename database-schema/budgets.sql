CREATE TABLE public.budgets (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    name text NOT NULL,
    monthly_budget numeric(12,2) NOT NULL,
    start_date date NOT NULL,
    end_date date,
    status text DEFAULT 'active'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT positive_budget CHECK ((monthly_budget >= (0)::numeric))
);

CREATE SEQUENCE public.budgets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.budgets_id_seq OWNED BY public.budgets.id;

ALTER TABLE ONLY public.budgets ALTER COLUMN id SET DEFAULT nextval('public.budgets_id_seq'::regclass);

ALTER TABLE ONLY public.budgets
    ADD CONSTRAINT budgets_pkey PRIMARY KEY (id);

CREATE INDEX idx_budgets_status ON public.budgets USING btree (status);

CREATE INDEX idx_budgets_user_id ON public.budgets USING btree (user_id);

CREATE TRIGGER update_budgets_updated_at BEFORE UPDATE ON public.budgets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE ONLY public.budgets
    ADD CONSTRAINT budgets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
