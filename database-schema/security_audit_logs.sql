CREATE TABLE public.security_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id integer,
    event_type character varying(50) NOT NULL,
    ip_address character varying(45),
    user_agent text,
    endpoint character varying(255),
    request_method character varying(10),
    details jsonb,
    severity character varying(20) DEFAULT 'info'::character varying,
    created_at timestamp without time zone DEFAULT now()
);

ALTER TABLE ONLY public.security_audit_logs
    ADD CONSTRAINT security_audit_logs_pkey PRIMARY KEY (id);

CREATE INDEX idx_security_audit_created ON public.security_audit_logs USING btree (created_at);

CREATE INDEX idx_security_audit_event_type ON public.security_audit_logs USING btree (event_type);

CREATE INDEX idx_security_audit_ip ON public.security_audit_logs USING btree (ip_address);

CREATE INDEX idx_security_audit_severity ON public.security_audit_logs USING btree (severity);

CREATE INDEX idx_security_audit_user_id ON public.security_audit_logs USING btree (user_id);

ALTER TABLE ONLY public.security_audit_logs
    ADD CONSTRAINT security_audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
