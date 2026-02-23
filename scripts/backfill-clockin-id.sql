-- Backfill clockin_id for existing staff who have username but no clockin_id
-- Staff use the last 6 digits of their username as their clock-in code
UPDATE staff
SET clockin_id = RIGHT(REGEXP_REPLACE(TRIM(username), '[^0-9]', '', 'g'), 6)
WHERE username IS NOT NULL
  AND (clockin_id IS NULL OR clockin_id = '')
  AND LENGTH(RIGHT(REGEXP_REPLACE(TRIM(username), '[^0-9]', '', 'g'), 6)) = 6;
