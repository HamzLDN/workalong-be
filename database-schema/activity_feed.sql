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

CREATE SEQUENCE public.activity_feed_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.activity_feed_id_seq OWNED BY public.activity_feed.id;

ALTER TABLE ONLY public.activity_feed ALTER COLUMN id SET DEFAULT nextval('public.activity_feed_id_seq'::regclass);

ALTER TABLE ONLY public.activity_feed
    ADD CONSTRAINT activity_feed_pkey PRIMARY KEY (id);

CREATE INDEX idx_activity_feed_created_at ON public.activity_feed USING btree (created_at DESC);

CREATE INDEX idx_activity_feed_type ON public.activity_feed USING btree (activity_type);

CREATE INDEX idx_activity_feed_user_id ON public.activity_feed USING btree (user_id);

ALTER TABLE ONLY public.activity_feed
    ADD CONSTRAINT activity_feed_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.shifts(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.activity_feed
    ADD CONSTRAINT activity_feed_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.activity_feed
    ADD CONSTRAINT activity_feed_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
