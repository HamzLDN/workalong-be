CREATE TABLE public.staff_password_tokens (
    id bigint NOT NULL,
    staff_id bigint NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

CREATE SEQUENCE public.staff_password_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.staff_password_tokens_id_seq OWNED BY public.staff_password_tokens.id;

ALTER TABLE ONLY public.staff_password_tokens ALTER COLUMN id SET DEFAULT nextval('public.staff_password_tokens_id_seq'::regclass);

ALTER TABLE ONLY public.staff_password_tokens
    ADD CONSTRAINT staff_password_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.staff_password_tokens
    ADD CONSTRAINT staff_password_tokens_token_key UNIQUE (token);

CREATE INDEX idx_staff_password_tokens_staff_id ON public.staff_password_tokens USING btree (staff_id);

CREATE INDEX idx_staff_password_tokens_token ON public.staff_password_tokens USING btree (token);

ALTER TABLE ONLY public.staff_password_tokens
    ADD CONSTRAINT staff_password_tokens_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;
