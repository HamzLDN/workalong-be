import { describe, it, expect } from '@jest/globals';
import {
  timesOverlap,
  resolveAvailabilityForShift,
  detectUnavailableStaffOnShift,
  AVAILABILITY_COLORS,
} from '../lib/availability.js';
import {
  canTransitionLeaveStatus,
  computeLeaveBalance,
  validateLeaveRequestInput,
} from '../lib/leaveRequests.js';
import { buildPayslipFromEntries, payslipSummaryText } from '../lib/payrollRuns.js';
import { buildNotification } from '../lib/notifications.js';
import {
  validateEscalationInput,
  canTransitionEscalationStatus,
  categoryLabel,
} from '../lib/escalationReports.js';

describe('availability lib', () => {
  it('detects overlapping time ranges', () => {
    expect(timesOverlap('09:00', '12:00', '11:00', '14:00')).toBe(true);
    expect(timesOverlap('09:00', '12:00', '12:00', '14:00')).toBe(false);
  });

  it('resolves unavailable for holiday slot', () => {
    const slots = [
      {
        weekday: 1,
        specific_date: null,
        is_recurring: true,
        start_time: '09:00',
        end_time: '17:00',
        status: 'holiday',
      },
    ];
    const r = resolveAvailabilityForShift(slots, {
      shiftDate: '2026-07-13',
      startTime: '10:00',
      endTime: '18:00',
    });
    expect(r.status).toBe('holiday');
    expect(r.color).toBe(AVAILABILITY_COLORS.holiday);
  });

  it('flags unavailable staff on shift', () => {
    const slots = [
      {
        weekday: 3,
        is_recurring: true,
        start_time: '08:00',
        end_time: '20:00',
        status: 'unavailable',
      },
    ];
    expect(
      detectUnavailableStaffOnShift(slots, {
        shiftDate: '2026-07-15',
        startTime: '09:00',
        endTime: '17:00',
      })
    ).toBe(true);
  });
});

describe('leaveRequests lib', () => {
  it('allows pending -> approved', () => {
    expect(canTransitionLeaveStatus('pending', 'approved')).toBe(true);
    expect(canTransitionLeaveStatus('approved', 'rejected')).toBe(false);
  });

  it('computes leave balance', () => {
    expect(computeLeaveBalance({ annualTargetHours: 150, approvedPaidHours: 40 })).toEqual({
      target: 150,
      used: 40,
      remaining: 110,
    });
  });

  it('validates leave input', () => {
    expect(validateLeaveRequestInput({ startDate: '2026-07-01', endDate: '2026-07-05', hours: 8 })).toBeNull();
    expect(validateLeaveRequestInput({ startDate: '2026-07-10', endDate: '2026-07-01', hours: 8 })).toBeTruthy();
  });
});

describe('payrollRuns lib', () => {
  it('builds payslip from time entries', () => {
    const payslip = buildPayslipFromEntries(
      [
        { date: '2026-07-01', hours_worked: 8, overtime_hours: 2, hourly_rate: 10, leave_category: 'none' },
      ],
      { pensionEmployeePercent: 5 }
    );
    expect(payslip.grossPay).toBe(110);
    expect(payslip.netPay).toBe(104.5);
    expect(payslip.lineItems).toHaveLength(1);
  });

  it('formats payslip summary text', () => {
    const text = payslipSummaryText({ grossPay: 100, netPay: 95, hoursWorked: 10 }, 'Jane');
    expect(text).toContain('Jane');
    expect(text).toContain('£100.00');
  });
});

describe('notifications lib', () => {
  it('builds valid notification payload', () => {
    const n = buildNotification({
      type: 'leave_submitted',
      title: 'Leave submitted',
      body: 'Test',
    });
    expect(n.type).toBe('leave_submitted');
  });

  it('rejects invalid notification type', () => {
    expect(() => buildNotification({ type: 'invalid', title: 'x' })).toThrow();
  });
});

describe('escalationReports lib', () => {
  it('validates escalation input', () => {
    expect(validateEscalationInput({ category: 'bullying', description: 'Long enough text here' })).toBeNull();
    expect(validateEscalationInput({ category: 'bad', description: 'Long enough text here' })).toBeTruthy();
  });

  it('allows open -> investigating', () => {
    expect(canTransitionEscalationStatus('open', 'investigating')).toBe(true);
  });

  it('labels categories', () => {
    expect(categoryLabel('health_safety')).toBe('Health & safety');
  });
});
