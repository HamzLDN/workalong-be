CREATE TABLE public.time_entries (
    id bigint NOT NULL,
    staff_id bigint NOT NULL,
    user_id bigint NOT NULL,
    date date NOT NULL,
    hours_worked numeric(5,2) NOT NULL,
    overtime_hours numeric(5,2) DEFAULT 0,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    entry_type text DEFAULT 'manual'::text,
    clock_in_time timestamp with time zone,
    clock_out_time timestamp with time zone,
    last_activity_time timestamp with time zone,
    edit_count integer DEFAULT 0,
    is_edited boolean DEFAULT false,
    shift_id bigint,
    CONSTRAINT positive_hours CHECK ((hours_worked >= (0)::numeric)),
    CONSTRAINT positive_overtime CHECK ((overtime_hours >= (0)::numeric))
);

COMMENT ON COLUMN public.time_entries.shift_id IS 'The shift that created this time entry (if approved from schedule)';

CREATE SEQUENCE public.time_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.time_entries_id_seq OWNED BY public.time_entries.id;

ALTER TABLE ONLY public.time_entries ALTER COLUMN id SET DEFAULT nextval('public.time_entries_id_seq'::regclass);

ALTER TABLE ONLY public.time_entries
    ADD CONSTRAINT time_entries_pkey PRIMARY KEY (id);

CREATE INDEX idx_time_entries_clock_in ON public.time_entries USING btree (clock_in_time);

CREATE INDEX idx_time_entries_date ON public.time_entries USING btree (date);

CREATE INDEX idx_time_entries_shift_id ON public.time_entries USING btree (shift_id);

CREATE INDEX idx_time_entries_staff_date ON public.time_entries USING btree (staff_id, date);

CREATE INDEX idx_time_entries_staff_id ON public.time_entries USING btree (staff_id);

CREATE INDEX idx_time_entries_user_id ON public.time_entries USING btree (user_id);

CREATE TRIGGER time_entry_edit_tracker BEFORE UPDATE ON public.time_entries FOR EACH ROW EXECUTE FUNCTION public.increment_edit_count();

CREATE TRIGGER update_time_entries_updated_at BEFORE UPDATE ON public.time_entries FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE ONLY public.time_entries
    ADD CONSTRAINT time_entries_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.shifts(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.time_entries
    ADD CONSTRAINT time_entries_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.time_entries
    ADD CONSTRAINT time_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- Circular ref: shifts.time_entry_id → time_entries; time_entries.shift_id → shifts. Add after both tables exist.
ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_time_entry_id_fkey FOREIGN KEY (time_entry_id) REFERENCES public.time_entries(id) ON DELETE SET NULL;
