export const AVAILABILITY_STATUSES = new Set([
  'available',
  'preferred',
  'unavailable',
  'holiday',
  'not_set',
]);

export const AVAILABILITY_COLORS = {
  available: '#22c55e',
  preferred: '#eab308',
  unavailable: '#ef4444',
  holiday: '#111827',
  not_set: '#9ca3af',
};

/** @param {string} start "HH:MM" or "HH:MM:SS" */
export function parseTimeToMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function timesOverlap(startA, endA, startB, endB) {
  const a0 = parseTimeToMinutes(startA);
  const a1 = parseTimeToMinutes(endA);
  const b0 = parseTimeToMinutes(startB);
  const b1 = parseTimeToMinutes(endB);
  if ([a0, a1, b0, b1].some((x) => x == null)) return false;
  return a0 < b1 && b0 < a1;
}

/**
 * Pick dominant availability status for a shift window on a given date.
 * @param {Array<{status:string,start_time:string,end_time:string,weekday?:number|null,specific_date?:string|null,is_recurring?:boolean}>} slots
 * @param {{shiftDate:string, startTime:string, endTime:string}} shift
 */
export function resolveAvailabilityForShift(slots, shift) {
  if (!slots?.length) return { status: 'not_set', color: AVAILABILITY_COLORS.not_set };

  const date = new Date(`${shift.shiftDate}T12:00:00`);
  const weekday = date.getDay();

  const matching = slots.filter((s) => {
    if (s.specific_date) return String(s.specific_date).slice(0, 10) === shift.shiftDate;
    if (s.is_recurring && s.weekday != null) return Number(s.weekday) === weekday;
    return false;
  });

  if (!matching.length) return { status: 'not_set', color: AVAILABILITY_COLORS.not_set };

  const overlapping = matching.filter((s) =>
    timesOverlap(s.start_time, s.end_time, shift.startTime, shift.endTime)
  );
  const pool = overlapping.length ? overlapping : matching;

  const priority = ['holiday', 'unavailable', 'preferred', 'available', 'not_set'];
  const best = pool.sort(
    (a, b) => priority.indexOf(a.status) - priority.indexOf(b.status)
  )[0];

  return {
    status: best.status,
    color: AVAILABILITY_COLORS[best.status] || AVAILABILITY_COLORS.not_set,
  };
}

export function detectUnavailableStaffOnShift(slots, shift) {
  const resolved = resolveAvailabilityForShift(slots, shift);
  return resolved.status === 'unavailable' || resolved.status === 'holiday';
}
