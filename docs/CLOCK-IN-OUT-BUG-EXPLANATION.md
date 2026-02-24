# How the 40-Hour Clock Bug Happened

## What You Experienced

You clocked in and out **5 times**, each within a few minutes (e.g. 22:05→22:08, 22:23→22:25, etc.).  
But the system shows all 5 as **22:xx → 15:02** (next day), with ~40 hours each.

## Root Cause

### 1. Multiple Entries

The system creates one time entry per clock-in. If you clock in 5 times (e.g. for testing or quick back-to-back shifts), you get 5 entries.  
Normally, each clock-out should close its corresponding entry with the real clock-out time.

### 2. The Bug: "Close Any Other Open Entries"

When you clock out, the code used to run:

```sql
UPDATE time_entries SET clock_out_time = [CURRENT_TIME], ...
WHERE staff_id = ? AND clock_in_time IS NOT NULL AND clock_out_time IS NULL
  AND date >= [TODAY] - 7 days
```

So it applied the **current** clock-out time to **all** open entries from the last 7 days.

### 3. Timeline That Explains Your Data

**Feb 5 (shift 22:00–23:00):**

1. 22:05 – Clock in → Entry 1 (clock_in=22:05, clock_out=NULL)  
2. 22:08 – Clock out → Entry 1 updated (clock_out=22:08)

3. 22:23 – Clock in → Entry 2 (clock_in=22:23, clock_out=NULL)  
4. 22:25 – Clock out → Entry 2 updated (clock_out=22:25)

... and so on for 5 cycles.  
If everything worked as intended, you’d see 5 short periods (a few minutes each).

**What likely went wrong**

On **Feb 7 at 15:02**, a clock-out ran (e.g. for another shift or a late “forgot to clock out”).  
The old logic then ran and set `clock_out_time = 15:02 Feb 7` for **all** still-open entries from the last 7 days.

So if any of those 5 entries were still open (clock_out=NULL), they all got overwritten with 15:02 Feb 7.

That can happen if:

- A clock-out failed or was never recorded (network, error, etc.).
- You used different devices (link vs app) and one path didn’t close entries correctly.
- There was a race condition where multiple clock-ins created entries before any clock-outs ran.

### 4. Why It Doesn’t Happen Anymore

The “close other entries” logic is now restricted to:

- **Today** and **yesterday** only (to support overnight shifts).

Entries older than that are **no longer updated** when you clock out.  
So a clock-out on Feb 7 will no longer overwrite Feb 5 entries.

## Fixes Applied

1. **Clock-out logic** – Only closes entries from today and yesterday (not 7 days).
2. **Payroll cap** – Clocked hours are capped at the shift’s scheduled duration (e.g. 1h for a 1h shift).
3. **Manual correction** – You can fix bad data by editing the shift and setting the correct Actual Clock-In/Out times, then re-approving.
