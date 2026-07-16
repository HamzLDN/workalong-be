export const PAYROLL_SCHEDULE_TYPES = new Set(['weekly', 'fortnightly', 'four_weekly', 'monthly']);

export function roundMoney(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * @param {Array<{hours_worked?:number,overtime_hours?:number,hourly_rate?:number,leave_category?:string}>} entries
 */
export function buildPayslipFromEntries(entries, { pensionEmployeePercent = 0 } = {}) {
  let regularHours = 0;
  let overtimeHours = 0;
  let gross = 0;
  const lineItems = [];

  for (const e of entries) {
    const rate = Number(e.hourly_rate) || 0;
    const reg = Number(e.hours_worked) || 0;
    const ot = Number(e.overtime_hours) || 0;
    const unpaid = e.leave_category === 'unpaid_leave';
    const regPay = unpaid ? 0 : reg * rate;
    const otPay = unpaid ? 0 : ot * rate * 1.5;
    regularHours += reg;
    overtimeHours += ot;
    gross += regPay + otPay;
    lineItems.push({
      date: e.date,
      regularHours: reg,
      overtimeHours: ot,
      rate,
      amount: roundMoney(regPay + otPay),
      leaveCategory: e.leave_category || 'none',
    });
  }

  const pensionDeduction = roundMoney(gross * (Number(pensionEmployeePercent) / 100));
  const net = roundMoney(Math.max(0, gross - pensionDeduction));

  return {
    grossPay: roundMoney(gross),
    netPay: net,
    hoursWorked: roundMoney(regularHours + overtimeHours),
    pensionDeduction,
    lineItems,
  };
}

export function payslipSummaryText(payslip, staffName) {
  return [
    `Payslip — ${staffName}`,
    `Gross: £${payslip.grossPay.toFixed(2)}`,
    `Net: £${payslip.netPay.toFixed(2)}`,
    `Hours: ${payslip.hoursWorked.toFixed(2)}`,
  ].join('\n');
}
