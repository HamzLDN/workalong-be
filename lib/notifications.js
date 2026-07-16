export const NOTIFICATION_TYPES = new Set([
  'leave_submitted',
  'leave_approved',
  'leave_rejected',
  'expense_submitted',
  'expense_approved',
  'expense_rejected',
  'rota_published',
  'payslip_ready',
  'document_expiring',
  'shift_swap_requested',
  'shift_swap_accepted',
  'general',
]);

export function buildNotification({ type, title, body, meta = {} }) {
  if (!NOTIFICATION_TYPES.has(type)) {
    throw new Error('Invalid notification type');
  }
  if (!title || typeof title !== 'string') {
    throw new Error('Notification title is required');
  }
  return { type, title, body: body || null, meta };
}
