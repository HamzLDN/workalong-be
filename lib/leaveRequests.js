export const LEAVE_STATUSES = new Set(['pending', 'approved', 'rejected', 'cancelled']);

export const LEAVE_CATEGORIES = new Set([
  'paid_leave',
  'unpaid_leave',
  'sick_leave',
  'maternity',
  'paternity',
  'compassionate',
  'study',
  'other',
]);

const TRANSITIONS = {
  pending: new Set(['approved', 'rejected', 'cancelled']),
  approved: new Set(),
  rejected: new Set(),
  cancelled: new Set(),
};

export function canTransitionLeaveStatus(from, to) {
  if (!LEAVE_STATUSES.has(from) || !LEAVE_STATUSES.has(to)) return false;
  return TRANSITIONS[from]?.has(to) ?? false;
}

export function computeLeaveBalance({ annualTargetHours = 0, approvedPaidHours = 0 }) {
  const target = Number(annualTargetHours) || 0;
  const used = Number(approvedPaidHours) || 0;
  const remaining = Math.max(0, target - used);
  return { target, used, remaining };
}

export function validateLeaveRequestInput({ startDate, endDate, hours, category }) {
  if (!startDate || !endDate) return 'Start and end dates are required';
  if (String(endDate) < String(startDate)) return 'End date must be on or after start date';
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 0) return 'Hours must be a non-negative number';
  if (category && !LEAVE_CATEGORIES.has(category)) return 'Invalid leave category';
  return null;
}
