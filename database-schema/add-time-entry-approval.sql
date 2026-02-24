-- Add per-time-entry approval for clock_in_out entries
-- Managers can approve each clock period individually from a table view

ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS approved_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS approved_by bigint REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_time_entries_approved_at ON time_entries(approved_at) WHERE approved_at IS NOT NULL;

COMMENT ON COLUMN time_entries.approved_at IS 'When this time entry was approved for payroll (clock_in_out only)';
COMMENT ON COLUMN time_entries.approved_by IS 'User ID who approved this time entry';

-- Backfill: mark existing clock_in_out entries as approved where shift is already approved
UPDATE time_entries te
SET approved_at = sh.approved_at, approved_by = sh.approved_by
FROM shifts sh
WHERE te.shift_id = sh.id
  AND sh.status = 'approved' AND sh.approved_at IS NOT NULL
  AND te.entry_type = 'clock_in_out'
  AND te.clock_in_time IS NOT NULL AND te.clock_out_time IS NOT NULL
  AND te.approved_at IS NULL;
