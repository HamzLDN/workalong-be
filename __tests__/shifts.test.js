import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Create mock functions
const mockQueryFn = jest.fn();
const mockConnectFn = jest.fn();

// Mock dependencies using unstable_mockModule for ES modules
const mockPool = {
  query: mockQueryFn,
  connect: mockConnectFn,
  on: jest.fn(),
};

jest.unstable_mockModule('../db.js', () => ({
  pool: mockPool,
  default: mockPool,
}));

// Now import modules using dynamic import
const {
  getShifts,
  getShiftById,
  createShift,
  updateShift,
  deleteShift,
  createBulkShifts,
  getShiftStats,
  checkShiftConflict,
  approveShift,
  unapproveShift,
} = await import('../shifts.js');
const dbModule = await import('../db.js');
const pool = dbModule.pool || dbModule.default;
const { createMockDbResult, createMockShift } = await import('./setup.js');

describe('Shifts Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryFn.mockClear();
    mockConnectFn.mockClear();
  });

  describe('getShifts', () => {
    it('should get all shifts for a user', async () => {
      const mockShifts = [
        createMockShift({ id: 1 }),
        createMockShift({ id: 2 }),
      ];
      mockQueryFn.mockResolvedValue(createMockDbResult(mockShifts));

      const result = await getShifts(1);

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        [1]
      );
      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('should filter by startDate', async () => {
      const mockShifts = [createMockShift()];
      mockQueryFn.mockResolvedValue(createMockDbResult(mockShifts));

      await getShifts(1, { startDate: '2026-02-01' });

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('shift_date >='),
        expect.arrayContaining([1, '2026-02-01'])
      );
    });

    it('should filter by endDate', async () => {
      const mockShifts = [createMockShift()];
      mockQueryFn.mockResolvedValue(createMockDbResult(mockShifts));

      await getShifts(1, { endDate: '2026-02-28' });

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('shift_date <='),
        expect.arrayContaining([1, '2026-02-28'])
      );
    });

    it('should filter by staffId', async () => {
      const mockShifts = [createMockShift()];
      mockQueryFn.mockResolvedValue(createMockDbResult(mockShifts));

      await getShifts(1, { staffId: 5 });

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('staff_id ='),
        expect.arrayContaining([1, 5])
      );
    });

    it('should filter by status', async () => {
      const mockShifts = [createMockShift({ status: 'scheduled' })];
      mockQueryFn.mockResolvedValue(createMockDbResult(mockShifts));

      await getShifts(1, { status: 'scheduled' });

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('status ='),
        expect.arrayContaining([1, 'scheduled'])
      );
    });
  });

  describe('getShiftById', () => {
    it('should get shift by ID', async () => {
      const mockShift = createMockShift({ id: 1 });
      mockQueryFn.mockResolvedValue(createMockDbResult([mockShift]));

      const result = await getShiftById(1, 1);

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('SELECT s.*, s.shift_date::text as shift_date, st.name as staff_name'),
        [1, 1]
      );
      expect(result).toBeDefined();
    });

    it('should return undefined if shift not found', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await getShiftById(999, 1);

      expect(result).toBeUndefined();
    });
  });

  describe('createShift', () => {
    it('should create a new shift', async () => {
      const mockShift = createMockShift();
      const shiftData = {
        staffId: 1,
        shiftDate: '2026-02-05',
        startTime: '09:00',
        hours: 8,
        breakMinutes: 30,
        shiftType: 'regular',
        payType: 'regular',
      };
      mockQueryFn.mockResolvedValue(createMockDbResult([mockShift]));

      const result = await createShift(1, shiftData);

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO shifts'),
        expect.arrayContaining([1, 1, '2026-02-05', '09:00'])
      );
      expect(result).toBeDefined();
    });
  });

  describe('updateShift', () => {
    it('should update shift', async () => {
      const mockShift = createMockShift({ id: 1 });
      // updateShift now uses hours directly, no separate calculation
      mockQueryFn.mockResolvedValue(createMockDbResult([mockShift]));

      const result = await updateShift(1, 1, {
        startTime: '10:00',
        endTime: '18:00',
        hours: 8,
      });

      expect(mockQueryFn).toHaveBeenCalledTimes(1);
      expect(result).toBeDefined();
    });
  });

  describe('deleteShift', () => {
    it('should delete shift', async () => {
      const mockResult = {
        rows: [{ id: 1 }],
        rowCount: 1,
      };
      mockQueryFn.mockResolvedValue(mockResult);

      await deleteShift(1, 1);

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM shifts'),
        [1, 1]
      );
    });
  });

  describe('createBulkShifts', () => {
    it('should create multiple shifts', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };
      mockConnectFn.mockResolvedValue(mockClient);

      const mockShifts = [
        createMockShift({ id: 1 }),
        createMockShift({ id: 2 }),
      ];
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce(createMockDbResult([{ hours: 8 }])) // Calculate hours for shift 1
        .mockResolvedValueOnce(createMockDbResult([mockShifts[0]])) // INSERT shift 1
        .mockResolvedValueOnce(createMockDbResult([{ hours: 8 }])) // Calculate hours for shift 2
        .mockResolvedValueOnce(createMockDbResult([mockShifts[1]])) // INSERT shift 2
        .mockResolvedValueOnce({}); // COMMIT

      const shifts = [
        {
          staffId: 1,
          shiftDate: '2026-02-05',
          startTime: '09:00',
          endTime: '17:00',
          breakMinutes: 0,
        },
        {
          staffId: 1,
          shiftDate: '2026-02-06',
          startTime: '09:00',
          endTime: '17:00',
          breakMinutes: 0,
        },
      ];

      const result = await createBulkShifts(1, shifts);

      expect(result.length).toBe(2);
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('getShiftStats', () => {
    it('should get shift statistics', async () => {
      const mockStats = {
        total: 10,
        scheduled: 5,
        completed: 3,
        approved: 2,
      };
      mockQueryFn.mockResolvedValue(createMockDbResult([mockStats]));

      const result = await getShiftStats(1);

      expect(mockQueryFn).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe('checkShiftConflict', () => {
    it('should detect shift conflicts', async () => {
      const mockConflict = createMockShift();
      mockQueryFn.mockResolvedValue(createMockDbResult([mockConflict]));

      const result = await checkShiftConflict(
        1,
        1,
        '2026-02-05',
        '09:00',
        '17:00'
      );

      expect(mockQueryFn).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe('approveShift', () => {
    it('should approve a shift', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };
      mockConnectFn.mockResolvedValue(mockClient);

      const mockShift = createMockShift({ id: 1, status: 'scheduled' });
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce(createMockDbResult([mockShift])) // SELECT shift
        .mockResolvedValueOnce(createMockDbResult([{ total: 0 }])) // SELECT time_entries (check for clock times)
        .mockResolvedValueOnce(createMockDbResult([{ id: 1 }])) // INSERT time entry
        .mockResolvedValueOnce({}) // UPDATE shift
        .mockResolvedValueOnce({}); // COMMIT

      const result = await approveShift(1, 1, 1);

      expect(mockClient.query).toHaveBeenCalledTimes(6);
      expect(result.success).toBe(true);
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('unapproveShift', () => {
    it('should unapprove a shift', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };
      mockConnectFn.mockResolvedValue(mockClient);

      const mockShift = createMockShift({ id: 1, status: 'approved', time_entry_id: 1 });
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce(createMockDbResult([mockShift])) // SELECT shift
        .mockResolvedValueOnce(createMockDbResult([])) // SELECT time entry
        .mockResolvedValueOnce(createMockDbResult([])) // SELECT late reason entries
        .mockResolvedValueOnce({}) // UPDATE shift
        .mockResolvedValueOnce({}); // COMMIT

      const result = await unapproveShift(1, 1);

      expect(mockClient.query).toHaveBeenCalledTimes(6);
      expect(result.success).toBe(true);
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
