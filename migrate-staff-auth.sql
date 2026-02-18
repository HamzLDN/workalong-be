-- Migration: Add staff authentication fields and clock in/out tracking
-- Run this script to add username, password_hash to staff table
-- and clock_in_time, clock_out_time to time_entries table

-- Add username and password_hash to staff table
ALTER TABLE staff 
ADD COLUMN IF NOT EXISTS username TEXT UNIQUE,
ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Create index on username for faster lookups
CREATE INDEX IF NOT EXISTS idx_staff_username ON staff(username);

-- Create staff_sessions table for staff authentication
CREATE TABLE IF NOT EXISTS staff_sessions (
  id UUID PRIMARY KEY,
  staff_id BIGINT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT
);

-- Create index on staff_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_staff_sessions_staff_id ON staff_sessions(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_sessions_expires ON staff_sessions(expires_at);

-- Add clock in/out timestamps to time_entries table
ALTER TABLE time_entries
ADD COLUMN IF NOT EXISTS clock_in_time TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS clock_out_time TIMESTAMP WITH TIME ZONE;

-- Create index on clock_in_time for faster queries
CREATE INDEX IF NOT EXISTS idx_time_entries_clock_in ON time_entries(clock_in_time);
CREATE INDEX IF NOT EXISTS idx_time_entries_staff_date ON time_entries(staff_id, date);

