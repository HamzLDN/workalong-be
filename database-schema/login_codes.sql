
--
-- Name: login_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_codes (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    code character varying(6) NOT NULL,
    email text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: login_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.login_codes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: login_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.login_codes_id_seq OWNED BY public.login_codes.id;


--
-- Name: login_codes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_codes ALTER COLUMN id SET DEFAULT nextval('public.login_codes_id_seq'::regclass);


--
-- Name: login_codes login_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_codes
    ADD CONSTRAINT login_codes_pkey PRIMARY KEY (id);


--
-- Name: login_codes unique_active_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_codes
    ADD CONSTRAINT unique_active_code UNIQUE (user_id, code, expires_at);


--
-- Name: idx_login_codes_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_login_codes_code ON public.login_codes USING btree (code);


--
-- Name: idx_login_codes_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_login_codes_expires ON public.login_codes USING btree (expires_at);


--
-- Name: idx_login_codes_user_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_login_codes_user_email ON public.login_codes USING btree (user_id, email);


--
-- Name: login_codes login_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_codes
    ADD CONSTRAINT login_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


