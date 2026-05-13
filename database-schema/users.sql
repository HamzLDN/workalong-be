CREATE TABLE public.users (
    id bigint NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    name text,
    is_verified boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    subscription_status text DEFAULT 'free'::text,
    subscription_plan text,
    subscription_start_date timestamp with time zone,
    subscription_end_date timestamp with time zone,
    payment_method text,
    last_payment_date timestamp with time zone,
    stripe_customer_id text,
    stripe_subscription_id text,
    latitude numeric(10,8),
    longitude numeric(11,8),
    subscription_staff_limit integer,
    location_radius integer DEFAULT 100,
    totp_secret text,
    totp_enabled boolean DEFAULT false,
    email_2fa_enabled boolean DEFAULT true,
    is_admin boolean DEFAULT false,
    CONSTRAINT valid_subscription_status CHECK ((subscription_status = ANY (ARRAY['free'::text, 'paid'::text, 'trial'::text, 'expired'::text])))
);

COMMENT ON COLUMN public.users.latitude IS 'Company location latitude (decimal degrees)';

COMMENT ON COLUMN public.users.longitude IS 'Company location longitude (decimal degrees)';

COMMENT ON COLUMN public.users.subscription_staff_limit IS 'Max staff allowed by current subscription; NULL = free/unlimited by plan';

COMMENT ON COLUMN public.users.location_radius IS 'Geofencing radius in meters. Staff must be within this distance to clock in/out.';

CREATE SEQUENCE public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

CREATE INDEX idx_users_email ON public.users USING btree (email);

CREATE INDEX idx_users_email_2fa_enabled ON public.users USING btree (email_2fa_enabled) WHERE (email_2fa_enabled = true);

CREATE INDEX idx_users_location ON public.users USING btree (latitude, longitude);

CREATE INDEX idx_users_stripe_customer ON public.users USING btree (stripe_customer_id);

CREATE INDEX idx_users_stripe_subscription ON public.users USING btree (stripe_subscription_id);

CREATE INDEX idx_users_subscription_status ON public.users USING btree (subscription_status);

CREATE INDEX idx_users_totp_enabled ON public.users USING btree (totp_enabled) WHERE (totp_enabled = true);
