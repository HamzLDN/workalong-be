
--
-- Name: activity_feed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_feed (
    id integer NOT NULL,
    user_id integer NOT NULL,
    activity_type character varying(50) NOT NULL,
    activity_title character varying(255) NOT NULL,
    activity_description text,
    staff_id integer,
    shift_id integer,
    icon character varying(20) DEFAULT '📋'::character varying,
    color character varying(20) DEFAULT 'blue'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: activity_feed_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.activity_feed_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: activity_feed_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.activity_feed_id_seq OWNED BY public.activity_feed.id;


--
-- Name: activity_feed id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_feed ALTER COLUMN id SET DEFAULT nextval('public.activity_feed_id_seq'::regclass);


--
-- Name: activity_feed activity_feed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_feed
    ADD CONSTRAINT activity_feed_pkey PRIMARY KEY (id);


--
-- Name: idx_activity_feed_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activity_feed_created_at ON public.activity_feed USING btree (created_at DESC);


--
-- Name: idx_activity_feed_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activity_feed_type ON public.activity_feed USING btree (activity_type);


--
-- Name: idx_activity_feed_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activity_feed_user_id ON public.activity_feed USING btree (user_id);


--
-- Name: activity_feed activity_feed_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_feed
    ADD CONSTRAINT activity_feed_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.shifts(id) ON DELETE SET NULL;


--
-- Name: activity_feed activity_feed_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_feed
    ADD CONSTRAINT activity_feed_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;


--
-- Name: activity_feed activity_feed_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_feed
    ADD CONSTRAINT activity_feed_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


