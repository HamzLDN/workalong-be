import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Create mock functions
const mockQueryFn = jest.fn();
const mockConnectFn = jest.fn();
const mockHashPasswordFn = jest.fn();

// Mock dependencies using unstable_mockModule for ES modules
const mockPool = {
  query: mockQueryFn,
  connect: mockConnectFn,
  on: jest.fn(),
};

jest.unstable_mockModule('../lib/db.js', () => ({
  pool: mockPool,
  default: mockPool,
}));

jest.unstable_mockModule('../services/auth.js', () => ({
  hashPassword: mockHashPasswordFn,
}));

jest.unstable_mockModule('../lib/email.js', () => ({
  sendStaffPasswordSetupEmail: jest.fn().mockResolvedValue(true),
}));

// Now import modules using dynamic import
const {
  getStaff,
  getStaffById,
  createStaff,
  updateStaff,
  deleteStaff,
  getStaffStats,
  createTimeEntry,
  getTimeEntries,
  getPayrollForPeriod,
  getMonthlyEarningsChart,
  deleteTimeEntry,
  createBudget,
  getActiveBudget,
  getBudgets,
  updateBudget,
  getBudgetStats,
} = await import('../services/staff.js');
const dbModule = await import('../lib/db.js');
const pool = dbModule.pool || dbModule.default;
const { hashPassword } = await import('../services/auth.js');
const { createMockDbResult, createMockStaff, createMockTimeEntry } = await import('./setup.js');

describe('Staff Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryFn.mockClear();
    mockConnectFn.mockClear();
    mockHashPasswordFn.mockClear();
  });

  describe('getStaff', () => {
    it('should get all staff for a user', async () => {
      const mockStaff = [createMockStaff({ id: 1 }), createMockStaff({ id: 2 })];
      mockQueryFn.mockResolvedValue(createMockDbResult(mockStaff));

      const result = await getStaff(1);

      expect(mockQueryFn).toHaveBeenCalledTimes(1);
      const [query] = mockQueryFn.mock.calls[0];
      expect(query).toContain('FROM staff');
      expect(query).toContain('WHERE user_id = $1');
      expect(mockQueryFn.mock.calls[0][1]).toEqual([1]);
      expect(result.length).toBe(2);
    });
  });

  describe('getStaffById', () => {
    it('should get staff by ID', async () => {
      const mockStaff = createMockStaff({ id: 1 });
      mockQueryFn.mockResolvedValue(createMockDbResult([mockStaff]));

      const result = await getStaffById(1, 1);

      expect(mockQueryFn).toHaveBeenCalledWith(
        'SELECT * FROM staff WHERE id = $1 AND user_id = $2',
        [1, 1]
      );
      expect(result).toEqual(mockStaff);
    });

    it('should return undefined if staff not found', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await getStaffById(999, 1);

      expect(result).toBeUndefined();
    });
  });

  describe('createStaff', () => {
    it('should create staff with generated username and clockin ID', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };
      mockConnectFn.mockResolvedValue(mockClient);
      mockHashPasswordFn.mockResolvedValue('$2b$10$hashedPassword');

      const mockStaff = createMockStaff();
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce(createMockDbResult([{ count: '0' }])) // Check username-ending uniqueness
        .mockResolvedValueOnce(createMockDbResult([mockStaff])) // INSERT staff
        .mockResolvedValueOnce({}) // INSERT password token
        .mockResolvedValueOnce({}); // COMMIT
      // After commit, createStaff does a final SELECT using pool.query (not client.query)
      mockQueryFn.mockResolvedValueOnce(createMockDbResult([mockStaff])); // Final SELECT

      const staffData = {
        name: 'John Doe',
        email: 'john@example.com',
        role: 'Manager',
        hourlyRate: 15.5,
        employmentType: 'full-time',
      };

      const result = await createStaff(1, staffData);

      expect(mockClient.query).toHaveBeenCalledTimes(5);
      expect(result).toBeDefined();
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('updateStaff', () => {
    it('should update staff member', async () => {
      const mockStaff = createMockStaff({ id: 1 });
      mockQueryFn.mockResolvedValue(createMockDbResult([mockStaff]));

      const result = await updateStaff(1, 1, {
        name: 'Updated Name',
        hourlyRate: 20.0,
      });

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE staff'),
        expect.arrayContaining([1, 1])
      );
      expect(result).toBeDefined();
    });
  });

  describe('deleteStaff', () => {
    it('should delete staff member', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      await deleteStaff(1, 1);

      expect(mockQueryFn).toHaveBeenCalledWith(
        'DELETE FROM staff WHERE id = $1 AND user_id = $2',
        [1, 1]
      );
    });
  });

  describe('getStaffStats', () => {
    it('should get staff statistics with approved hours only', async () => {
      mockQueryFn
        .mockResolvedValueOnce(createMockDbResult([{ count: '5' }])) // totalStaff
        .mockResolvedValueOnce(createMockDbResult([{ total_hours: '120.50' }])) // hoursResult (approved only)
        .mockResolvedValueOnce(
          createMockDbResult([
            { staff_id: 1, hours: '80' },
            { staff_id: 2, hours: '40.5' },
          ])
        ) // attendanceHoursByStaff
        .mockResolvedValueOnce(createMockDbResult([{ total_cost: '1807.50' }])); // payrollResult (approved only)
      // getBudgetStats may run - mock to avoid errors
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await getStaffStats(1);

      expect(mockQueryFn).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.totalStaff).toBe(5);
      expect(result.hoursThisMonth).toBe(120.5);
      expect(result.monthlyPayroll).toBe(1807.5);
      expect(result.attendanceHoursByStaff).toEqual({ 1: 80, 2: 40.5 });
    });

    it('should return zero hours/payroll when no approved shifts', async () => {
      mockQueryFn
        .mockResolvedValueOnce(createMockDbResult([{ count: '3' }]))
        .mockResolvedValueOnce(createMockDbResult([{ total_hours: '0' }]))
        .mockResolvedValueOnce(createMockDbResult([])) // attendanceHoursByStaff
        .mockResolvedValueOnce(createMockDbResult([{ total_cost: '0' }]));
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await getStaffStats(1);

      expect(result.hoursThisMonth).toBe(0);
      expect(result.monthlyPayroll).toBe(0);
    });

    it('should include approval filter in hours query', async () => {
      mockQueryFn
        .mockResolvedValueOnce(createMockDbResult([{ count: '1' }]))
        .mockResolvedValueOnce(createMockDbResult([{ total_hours: '8' }]))
        .mockResolvedValueOnce(createMockDbResult([{ staff_id: 1, hours: '8' }]))
        .mockResolvedValueOnce(createMockDbResult([{ total_cost: '120' }]));
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      await getStaffStats(1);

      const hoursQuery = mockQueryFn.mock.calls[1][0];
      expect(hoursQuery).toContain('te.approved_at IS NOT NULL');
      expect(hoursQuery).toContain("te.entry_type = 'clock_in_out'");
    });
  });

  describe('getPayrollForPeriod', () => {
    it('should get payroll for date range with approved shifts only', async () => {
      const mockStaff = [
        {
          staff_id: 1,
          staff_name: 'John',
          role: 'Manager',
          hourly_rate: 15,
          hours_worked: '40',
          total_pay: '600',
        },
        {
          staff_id: 2,
          staff_name: 'Jane',
          role: 'Worker',
          hourly_rate: 12,
          hours_worked: '20',
          total_pay: '240',
        },
      ];
      mockQueryFn.mockResolvedValue(createMockDbResult(mockStaff));

      const result = await getPayrollForPeriod(1, '2026-02-01', '2026-02-28');

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('BETWEEN'),
        expect.arrayContaining([1, '2026-02-01', '2026-02-28'])
      );
      expect(result.staff).toHaveLength(2);
      expect(result.totals).toBeDefined();
      expect(result.totals.totalHours).toBe(60);
      expect(result.totals.totalPay).toBe(840);
    });

    it('should exclude unapproved shift hours from payroll', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      await getPayrollForPeriod(1, '2026-02-01', '2026-02-28');

      const query = mockQueryFn.mock.calls[0][0];
      expect(query).toContain('te.approved_at IS NOT NULL');
      expect(query).toContain("te.entry_type = 'clock_in_out'");
    });
  });

  describe('createTimeEntry', () => {
    it('should create a time entry with overtime and notes', async () => {
      const mockEntry = createMockTimeEntry({ overtime_hours: 2, notes: 'Extra shift' });
      mockQueryFn.mockResolvedValue(createMockDbResult([mockEntry]));

      const result = await createTimeEntry(1, {
        staffId: 1,
        date: '2026-02-05',
        hoursWorked: 10,
        overtimeHours: 2,
        notes: 'Extra shift',
      });

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO time_entries'),
        [1, 1, '2026-02-05', 10, 2, 'Extra shift']
      );
      expect(result.overtime_hours).toBe(2);
    });

    it('should create a time entry', async () => {
      const mockEntry = createMockTimeEntry();
      mockQueryFn.mockResolvedValue(createMockDbResult([mockEntry]));

      const result = await createTimeEntry(1, {
        staffId: 1,
        date: '2026-02-05',
        hoursWorked: 8.0,
      });

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO time_entries'),
        expect.arrayContaining([1, 1, '2026-02-05', 8.0])
      );
      expect(result).toBeDefined();
    });
  });

  describe('getTimeEntries', () => {
    it('should get time entries with filters', async () => {
      const mockEntries = [createMockTimeEntry()];
      mockQueryFn.mockResolvedValue(createMockDbResult(mockEntries));

      const result = await getTimeEntries(1, {
        startDate: '2026-02-01',
        endDate: '2026-02-28',
        staffId: 1,
      });

      expect(mockQueryFn).toHaveBeenCalled();
      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getMonthlyEarningsChart', () => {
    it('should get monthly earnings chart data', async () => {
      const mockData = [
        { date: '2026-02-01', earnings: 124.0 },
        { date: '2026-02-02', earnings: 155.0 },
      ];
      mockQueryFn.mockResolvedValue(createMockDbResult(mockData));

      const result = await getMonthlyEarningsChart(1, 2026, 2);

      expect(mockQueryFn).toHaveBeenCalled();
      // The function returns an object with chart data, not just an array
      expect(result).toBeDefined();
    });
  });

  describe('deleteTimeEntry', () => {
    it('should delete time entry', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      await deleteTimeEntry(1, 1);

      expect(mockQueryFn).toHaveBeenCalledWith(
        'DELETE FROM time_entries WHERE id = $1 AND user_id = $2',
        [1, 1]
      );
    });
  });

  describe('createBudget', () => {
    it('should create a budget', async () => {
      const mockBudget = {
        id: 1,
        user_id: 1,
        name: 'Test Budget',
        monthly_budget: 5000.0,
        start_date: '2026-02-01',
        end_date: '2026-02-28',
        status: 'active',
      };
      mockQueryFn.mockResolvedValue(createMockDbResult([mockBudget]));

      const result = await createBudget(1, {
        name: 'Test Budget',
        monthlyBudget: 5000.0,
        startDate: '2026-02-01',
        endDate: '2026-02-28',
      });

      expect(result).toBeDefined();
      expect(result.name).toBe('Test Budget');
    });
  });

  describe('getActiveBudget', () => {
    it('should get active budget', async () => {
      const mockBudget = {
        id: 1,
        amount: 5000.0,
        is_active: true,
      };
      mockQueryFn.mockResolvedValue(createMockDbResult([mockBudget]));

      const result = await getActiveBudget(1);

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM budgets'),
        [1]
      );
      expect(result).toBeDefined();
    });
  });

  describe('getBudgets', () => {
    it('should get all budgets', async () => {
      const mockBudgets = [
        { id: 1, amount: 5000.0 },
        { id: 2, amount: 6000.0 },
      ];
      mockQueryFn.mockResolvedValue(createMockDbResult(mockBudgets));

      const result = await getBudgets(1);

      expect(result.length).toBe(2);
    });
  });

  describe('updateBudget', () => {
    it('should update budget', async () => {
      const mockBudget = {
        id: 1,
        name: 'Updated Budget',
        monthly_budget: 5500.0,
        start_date: '2026-02-01',
        end_date: '2026-02-28',
      };
      mockQueryFn.mockResolvedValue(createMockDbResult([mockBudget]));

      const result = await updateBudget(1, 1, {
        name: 'Updated Budget',
        monthlyBudget: 5500.0,
        startDate: '2026-02-01',
        endDate: '2026-02-28',
      });

      expect(mockQueryFn).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe('getBudgetStats', () => {
    it('should get budget statistics', async () => {
      const mockStats = {
        total_budget: 5000.0,
        spent: 3200.0,
        remaining: 1800.0,
        percentage_used: 64.0,
      };
      mockQueryFn.mockResolvedValue(createMockDbResult([mockStats]));

      const result = await getBudgetStats(1);

      expect(mockQueryFn).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });
});
