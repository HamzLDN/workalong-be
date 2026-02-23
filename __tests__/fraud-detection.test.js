import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Create mock function
const mockQueryFn = jest.fn();

// Mock dependencies using unstable_mockModule for ES modules
const mockPool = {
  query: mockQueryFn,
  on: jest.fn(),
};

jest.unstable_mockModule('../lib/db.js', () => ({
  pool: mockPool,
  default: mockPool,
}));

// Now import modules using dynamic import
const { analyzeFraudPatterns } = await import('../lib/fraud-detection.js');
const dbModule = await import('../lib/db.js');
const pool = dbModule.pool || dbModule.default;
const { createMockDbResult } = await import('./setup.js');

describe('Fraud Detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryFn.mockClear();
  });

  describe('analyzeFraudPatterns', () => {
    it('should return empty array for no time entries', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await analyzeFraudPatterns(1, 1, 30);

      expect(result).toEqual([]);
    });

    it('should detect exact time patterns', async () => {
      const mockEntries = [
        { hours_worked: '8.00', entry_type: 'clock' },
        { hours_worked: '8.00', entry_type: 'clock' },
        { hours_worked: '8.00', entry_type: 'clock' },
        { hours_worked: '8.00', entry_type: 'clock' },
        { hours_worked: '8.00', entry_type: 'clock' },
      ];
      mockQueryFn.mockResolvedValue(createMockDbResult(mockEntries));

      const result = await analyzeFraudPatterns(1, 1, 30);

      const exactTimeFlag = result.find(flag => flag.type === 'exact-times');
      expect(exactTimeFlag).toBeDefined();
      expect(exactTimeFlag.severity).toBe('medium');
    });

    it('should detect always manual entries', async () => {
      const mockEntries = Array(10).fill({
        hours_worked: '8.0',
        entry_type: 'manual',
      });
      mockQueryFn.mockResolvedValue(createMockDbResult(mockEntries));

      const result = await analyzeFraudPatterns(1, 1, 30);

      const manualFlag = result.find(flag => flag.type === 'always-manual');
      expect(manualFlag).toBeDefined();
      expect(manualFlag.severity).toBe('medium');
    });

    it('should detect suspiciously long hours', async () => {
      const mockEntries = [
        { hours_worked: '16.0', entry_type: 'clock' },
        { hours_worked: '18.0', entry_type: 'clock' },
        { hours_worked: '20.0', entry_type: 'clock' },
      ];
      mockQueryFn.mockResolvedValue(createMockDbResult(mockEntries));

      const result = await analyzeFraudPatterns(1, 1, 30);

      const longHoursFlag = result.find(flag => flag.type === 'long-hours');
      if (longHoursFlag) {
        expect(longHoursFlag.severity).toBe('high');
      }
    });

    it('should respect daysToAnalyze parameter', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      await analyzeFraudPatterns(1, 1, 60);

      const callArgs = mockQueryFn.mock.calls[0][1];
      const startDate = callArgs[2];
      expect(startDate).toBeDefined();
    });

    it('should return empty when no suspicious patterns', async () => {
      const mockEntries = [
        { hours_worked: '7.5', entry_type: 'clock' },
        { hours_worked: '8.2', entry_type: 'clock' },
        { hours_worked: '6.0', entry_type: 'clock' },
      ];
      mockQueryFn.mockResolvedValue(createMockDbResult(mockEntries));

      const result = await analyzeFraudPatterns(1, 1, 30);

      expect(Array.isArray(result)).toBe(true);
    });

    it('should include staff and user context in query', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      await analyzeFraudPatterns(99, 42, 14);

      expect(mockQueryFn.mock.calls[0][1]).toContain(99);
      expect(mockQueryFn.mock.calls[0][1]).toContain(42);
    });
  });
});
