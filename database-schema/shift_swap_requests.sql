CREATE TABLE public.shift_swap_requests (
    id bigint NOT NULL,
    requester_shift_id bigint NOT NULL,
    requested_shift_id bigint NOT NULL,
    requester_staff_id bigint NOT NULL,
    requested_staff_id bigint NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    message text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    resolved_at timestamp with time zone,
    CONSTRAINT shift_swap_requests_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('accepted'::character varying)::text, ('rejected'::character varying)::text, ('cancelled'::character varying)::text])))
);

CREATE SEQUENCE public.shift_swap_requests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.shift_swap_requests_id_seq OWNED BY public.shift_swap_requests.id;

ALTER TABLE ONLY public.shift_swap_requests ALTER COLUMN id SET DEFAULT nextval('public.shift_swap_requests_id_seq'::regclass);

ALTER TABLE ONLY public.shift_swap_requests
    ADD CONSTRAINT shift_swap_requests_pkey PRIMARY KEY (id);

CREATE INDEX idx_shift_swap_requests_requested_shift ON public.shift_swap_requests USING btree (requested_shift_id);

CREATE INDEX idx_shift_swap_requests_requested_staff ON public.shift_swap_requests USING btree (requested_staff_id);

CREATE INDEX idx_shift_swap_requests_requester_shift ON public.shift_swap_requests USING btree (requester_shift_id);

CREATE INDEX idx_shift_swap_requests_requester_staff ON public.shift_swap_requests USING btree (requester_staff_id);

CREATE INDEX idx_shift_swap_requests_status ON public.shift_swap_requests USING btree (status);

CREATE TRIGGER shift_swap_requests_updated_at BEFORE UPDATE ON public.shift_swap_requests FOR EACH ROW EXECUTE FUNCTION public.update_shift_swap_requests_updated_at();

ALTER TABLE ONLY public.shift_swap_requests
    ADD CONSTRAINT shift_swap_requests_requested_shift_id_fkey FOREIGN KEY (requested_shift_id) REFERENCES public.shifts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.shift_swap_requests
    ADD CONSTRAINT shift_swap_requests_requested_staff_id_fkey FOREIGN KEY (requested_staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.shift_swap_requests
    ADD CONSTRAINT shift_swap_requests_requester_shift_id_fkey FOREIGN KEY (requester_shift_id) REFERENCES public.shifts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.shift_swap_requests
    ADD CONSTRAINT shift_swap_requests_requester_staff_id_fkey FOREIGN KEY (requester_staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;
