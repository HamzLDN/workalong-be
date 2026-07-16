export const ESCALATION_CATEGORIES = new Set([
  'bullying',
  'harassment',
  'health_safety',
  'payroll_issue',
  'discrimination',
  'equipment_issue',
  'shift_concern',
  'manager_concern',
  'whistleblowing',
  'other',
]);

export const ESCALATION_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

export const ESCALATION_STATUSES = new Set(['open', 'investigating', 'resolved', 'escalated']);

const STATUS_TRANSITIONS = {
  open: new Set(['investigating', 'resolved', 'escalated']),
  investigating: new Set(['resolved', 'escalated']),
  resolved: new Set(),
  escalated: new Set(['investigating', 'resolved']),
};

export function canTransitionEscalationStatus(from, to) {
  if (!ESCALATION_STATUSES.has(from) || !ESCALATION_STATUSES.has(to)) return false;
  return STATUS_TRANSITIONS[from]?.has(to) ?? false;
}

export function categoryLabel(cat) {
  const labels = {
    bullying: 'Bullying',
    harassment: 'Harassment',
    health_safety: 'Health & safety',
    payroll_issue: 'Payroll issue',
    discrimination: 'Discrimination',
    equipment_issue: 'Equipment issue',
    shift_concern: 'Shift concern',
    manager_concern: 'Manager concern',
    whistleblowing: 'Whistleblowing',
    other: 'Other',
  };
  return labels[cat] || cat;
}

export function validateEscalationInput({ category, severity, description }) {
  if (!category || !ESCALATION_CATEGORIES.has(category)) return 'Valid category is required';
  if (severity && !ESCALATION_SEVERITIES.has(severity)) return 'Invalid severity';
  const desc = String(description || '').trim();
  if (desc.length < 10) return 'Description must be at least 10 characters';
  return null;
}

export function appendTimelineEntry(timeline, { actor, note, status }) {
  const list = Array.isArray(timeline) ? [...timeline] : [];
  list.push({
    at: new Date().toISOString(),
    actor: actor || 'system',
    note: note || '',
    status: status || null,
  });
  return list;
}
