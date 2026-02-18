--
-- PostgreSQL database dump (functions and triggers only)
-- Dumped from database version 16.11
-- Dumped by pg_dump version 16.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS '';


--
-- Name: calculate_shift_hours(time without time zone, time without time zone, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.calculate_shift_hours(start_time time without time zone, end_time time without time zone, break_minutes integer DEFAULT 0) RETURNS numeric
    LANGUAGE plpgsql
    AS $$
DECLARE
  total_minutes INTEGER;
  work_minutes INTEGER;
  start_seconds INTEGER;
  end_seconds INTEGER;
BEGIN
  -- Convert times to seconds since midnight
  start_seconds := EXTRACT(EPOCH FROM start_time)::INTEGER;
  end_seconds := EXTRACT(EPOCH FROM end_time)::INTEGER;
  
  -- If end_time is less than start_time, it's an overnight shift (e.g., 23:00 to 05:00)
  -- Add 24 hours (86400 seconds) to end_seconds for calculation
  IF end_seconds < start_seconds THEN
    end_seconds := end_seconds + 86400;
  END IF;
  
  total_minutes := (end_seconds - start_seconds) / 60;
  work_minutes := total_minutes - COALESCE(break_minutes, 0);
  
  -- Ensure we don't return negative hours
  IF work_minutes < 0 THEN
    RETURN 0;
  END IF;
  
  RETURN ROUND(work_minutes::DECIMAL / 60, 2);
END;
$$;


--
-- Name: cleanup_old_activities(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_old_activities() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM activity_feed 
  WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$;


--
-- Name: cleanup_old_rate_limit_logs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_old_rate_limit_logs() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM rate_limit_logs WHERE created_at < NOW() - INTERVAL '24 hours';
END;
$$;


--
-- Name: cleanup_old_security_audit_logs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_old_security_audit_logs() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM security_audit_logs WHERE created_at < NOW() - INTERVAL '90 days' AND severity != 'critical';
  -- Keep critical logs for 1 year
  DELETE FROM security_audit_logs WHERE created_at < NOW() - INTERVAL '1 year' AND severity = 'critical';
END;
$$;


--
-- Name: generate_clockin_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_clockin_id() RETURNS character varying
    LANGUAGE plpgsql
    AS $$
DECLARE
  new_id VARCHAR(6);
  exists_check INTEGER;
BEGIN
  LOOP
    -- Generate random 6-digit number (100000-999999)
    new_id := LPAD(FLOOR(RANDOM() * 900000 + 100000)::TEXT, 6, '0');
    
    -- Check if ID already exists
    SELECT COUNT(*) INTO exists_check FROM staff WHERE clockin_id = new_id;
    
    -- If ID doesn't exist, return it
    IF exists_check = 0 THEN
      RETURN new_id;
    END IF;
  END LOOP;
END;
$$;


--
-- Name: increment_edit_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_edit_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.hours_worked != NEW.hours_worked OR OLD.overtime_hours != NEW.overtime_hours THEN
    NEW.edit_count = OLD.edit_count + 1;
    NEW.is_edited = TRUE;
    NEW.updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: update_shift_swap_requests_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_shift_swap_requests_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

