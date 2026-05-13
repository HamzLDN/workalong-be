CREATE TABLE public.rate_limit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    identifier character varying(255) NOT NULL,
    endpoint character varying(255) NOT NULL,
    request_count integer DEFAULT 1,
    window_start timestamp without time zone NOT NULL,
    window_type character varying(20) NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);

ALTER TABLE ONLY public.rate_limit_logs
    ADD CONSTRAINT rate_limit_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rate_limit_logs
    ADD CONSTRAINT unique_rate_limit UNIQUE (identifier, endpoint, window_start, window_type);

CREATE INDEX idx_rate_limit_cleanup ON public.rate_limit_logs USING btree (created_at);

CREATE INDEX idx_rate_limit_identifier ON public.rate_limit_logs USING btree (identifier);

CREATE INDEX idx_rate_limit_window ON public.rate_limit_logs USING btree (window_start, window_type);
