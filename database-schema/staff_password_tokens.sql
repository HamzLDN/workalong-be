
--
-- Name: staff_password_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_password_tokens (
    id bigint NOT NULL,
    staff_id bigint NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: staff_password_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_password_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_password_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_password_tokens_id_seq OWNED BY public.staff_password_tokens.id;


--
-- Name: staff_password_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_password_tokens ALTER COLUMN id SET DEFAULT nextval('public.staff_password_tokens_id_seq'::regclass);


--
-- Name: staff_password_tokens staff_password_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_password_tokens
    ADD CONSTRAINT staff_password_tokens_pkey PRIMARY KEY (id);


--
-- Name: staff_password_tokens staff_password_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_password_tokens
    ADD CONSTRAINT staff_password_tokens_token_key UNIQUE (token);


--
-- Name: idx_staff_password_tokens_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_password_tokens_staff_id ON public.staff_password_tokens USING btree (staff_id);


--
-- Name: idx_staff_password_tokens_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_password_tokens_token ON public.staff_password_tokens USING btree (token);


--
-- Name: staff_password_tokens staff_password_tokens_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_password_tokens
    ADD CONSTRAINT staff_password_tokens_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


