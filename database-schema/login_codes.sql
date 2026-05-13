CREATE TABLE public.login_codes (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    code character varying(6) NOT NULL,
    email text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

CREATE SEQUENCE public.login_codes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.login_codes_id_seq OWNED BY public.login_codes.id;

ALTER TABLE ONLY public.login_codes ALTER COLUMN id SET DEFAULT nextval('public.login_codes_id_seq'::regclass);

ALTER TABLE ONLY public.login_codes
    ADD CONSTRAINT login_codes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.login_codes
    ADD CONSTRAINT unique_active_code UNIQUE (user_id, code, expires_at);

CREATE INDEX idx_login_codes_code ON public.login_codes USING btree (code);

CREATE INDEX idx_login_codes_expires ON public.login_codes USING btree (expires_at);

CREATE INDEX idx_login_codes_user_email ON public.login_codes USING btree (user_id, email);

ALTER TABLE ONLY public.login_codes
    ADD CONSTRAINT login_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
