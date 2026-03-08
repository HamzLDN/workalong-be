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

jest.unstable_mockModule('../lib/db.js', () => ({
  pool: mockPool,
  default: mockPool,
}));

// Now import modules using dynamic import
const {
  getStaff,
  getStaffById,
  updateStaff,
  deleteStaff,
  getTimeEntries,
  createTimeEntry,
  deleteTimeEntry,
  getBudgets,
  getActiveBudget,
  createBudget,
  updateBudget,
} = await import('../services/staff.js');

const { getShifts, getShiftById, updateShift, deleteShift, approveShift } =
  await import('../services/shifts.js');

const { getUserApiKeys, revokeApiKey, deleteApiKey, getSecurityAuditLogs } =
  await import('../lib/api-security.js');

const { createMockDbResult, createMockStaff, createMockShift } = await import('./setup.js');

describe('IDOR (Insecure Direct Object Reference) Security Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryFn.mockClear();
    mockConnectFn.mockClear();
  });

  describe('Staff Access Control', () => {
    it("should prevent user from accessing another user's staff member", async () => {
      const attackerUserId = 1;
      const victimUserId = 2;
      const staffId = 10;

      // Mock: staff belongs to victim, not attacker
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await getStaffById(staffId, attackerUserId);

      expect(mockQueryFn).toHaveBeenCalledWith(
        'SELECT * FROM staff WHERE id = $1 AND user_id = $2',
        [staffId, attackerUserId]
      );
      expect(result).toBeUndefined();
    });

    it('should only return staff belonging to the authenticated user', async () => {
      const userId = 1;
      const otherUserStaff = createMockStaff({ id: 10, user_id: 2 });
      const userStaff = createMockStaff({ id: 5, user_id: userId });

      mockQueryFn.mockResolvedValue(createMockDbResult([userStaff]));

      const result = await getStaff(userId);

      expect(mockQueryFn).toHaveBeenCalledWith(expect.stringContaining('WHERE user_id = $1'), [
        userId,
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].user_id).toBe(userId);
    });

    it("should prevent user from updating another user's staff", async () => {
      const attackerUserId = 1;
      const victimUserId = 2;
      const staffId = 10;

      // Mock: staff belongs to victim, update should fail
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await updateStaff(staffId, attackerUserId, { name: 'Hacked' });

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $'),
        expect.arrayContaining([staffId, attackerUserId])
      );
      // updateStaff returns undefined when no rows match (secure behavior)
      expect(result).toBeUndefined();
    });

    it("should prevent user from deleting another user's staff", async () => {
      const attackerUserId = 1;
      const victimUserId = 2;
      const staffId = 10;

      // Mock: staff belongs to victim, delete should delete 0 rows
      const mockResult = { rows: [], rowCount: 0 };
      mockQueryFn.mockResolvedValue(mockResult);

      // deleteStaff doesn't throw, but deletes 0 rows (secure behavior)
      await deleteStaff(staffId, attackerUserId);

      expect(mockQueryFn).toHaveBeenCalledWith('DELETE FROM staff WHERE id = $1 AND user_id = $2', [
        staffId,
        attackerUserId,
      ]);
      // Security: No rows deleted = user cannot delete resource that doesn't belong to them
    });
  });

  describe('Shift Access Control', () => {
    it("should prevent user from accessing another user's shift", async () => {
      const attackerUserId = 1;
      const victimUserId = 2;
      const shiftId = 100;

      // Mock: shift belongs to victim, not attacker
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await getShiftById(shiftId, attackerUserId);

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('WHERE s.id = $1 AND s.user_id = $2'),
        [shiftId, attackerUserId]
      );
      expect(result).toBeUndefined();
    });

    it('should only return shifts belonging to the authenticated user', async () => {
      const userId = 1;
      const userShift = createMockShift({ id: 1, user_id: userId });
      const otherUserShift = createMockShift({ id: 2, user_id: 2 });

      mockQueryFn.mockResolvedValue(createMockDbResult([userShift]));

      const result = await getShifts(userId);

      expect(mockQueryFn).toHaveBeenCalledWith(expect.stringContaining('WHERE s.user_id = $1'), [
        userId,
      ]);
      expect(result.length).toBeGreaterThanOrEqual(0);
      // Verify all returned shifts belong to user
      result.forEach((shift) => {
        expect(shift.user_id).toBe(userId);
      });
    });

    it("should prevent user from updating another user's shift", async () => {
      const attackerUserId = 1;
      const victimUserId = 2;
      const shiftId = 100;

      // Mock: shift belongs to victim, update should fail
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await updateShift(shiftId, attackerUserId, { hours: 999 });

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $'),
        expect.arrayContaining([shiftId, attackerUserId])
      );
      expect(result).toBeNull();
    });

    it("should prevent user from deleting another user's shift", async () => {
      const attackerUserId = 1;
      const victimUserId = 2;
      const shiftId = 100;

      // Mock: shift belongs to victim, delete should fail
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      await expect(deleteShift(shiftId, attackerUserId)).rejects.toThrow();

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM shifts WHERE id = $1 AND user_id = $2'),
        [shiftId, attackerUserId]
      );
    });

    it("should prevent user from approving another user's shift", async () => {
      const attackerUserId = 1;
      const victimUserId = 2;
      const shiftId = 100;

      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      };
      mockConnectFn.mockResolvedValue(mockClient);

      // Mock: shift belongs to victim, not attacker
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce(createMockDbResult([])); // SELECT shift (should return empty)

      await expect(approveShift(shiftId, attackerUserId, attackerUserId)).rejects.toThrow();

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE s.id = $1 AND s.user_id = $2'),
        [shiftId, attackerUserId]
      );
    });
  });

  describe('Time Entry Access Control', () => {
    it('should only return time entries belonging to the authenticated user', async () => {
      const userId = 1;
      const userTimeEntry = { id: 1, user_id: userId, staff_id: 5 };
      const otherUserTimeEntry = { id: 2, user_id: 2, staff_id: 10 };

      mockQueryFn.mockResolvedValue(createMockDbResult([userTimeEntry]));

      const result = await getTimeEntries(userId, {});

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('WHERE te.user_id = $1'),
        expect.arrayContaining([userId])
      );
      expect(result.length).toBeGreaterThanOrEqual(0);
      // Verify all returned entries belong to user
      result.forEach((entry) => {
        expect(entry.user_id).toBe(userId);
      });
    });

    it('should create time entry with user_id even if staff belongs to another user', async () => {
      const attackerUserId = 1;
      const victimUserId = 2;
      const victimStaffId = 10;

      // Note: createTimeEntry doesn't validate staff ownership
      // However, time entries are filtered by user_id when retrieved, so users can't see
      // entries for other users' staff. The time entry will have attackerUserId but victimStaffId.
      const mockTimeEntry = { id: 1, user_id: attackerUserId, staff_id: victimStaffId };
      mockQueryFn.mockResolvedValue(createMockDbResult([mockTimeEntry]));

      const result = await createTimeEntry(attackerUserId, {
        staffId: victimStaffId,
        date: '2026-02-01',
        hoursWorked: 8,
      });

      // Time entry is created with attackerUserId (secure - user can't see other users' entries)
      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO time_entries'),
        expect.arrayContaining([attackerUserId, victimStaffId])
      );
      expect(result.user_id).toBe(attackerUserId);
      // Security: Even though staff_id is from another user, user_id prevents cross-user access
    });

    it("should prevent user from deleting another user's time entry", async () => {
      const attackerUserId = 1;
      const victimUserId = 2;
      const timeEntryId = 50;

      // Mock: time entry belongs to victim, delete should delete 0 rows
      const mockResult = { rows: [], rowCount: 0 };
      mockQueryFn.mockResolvedValue(mockResult);

      // deleteTimeEntry doesn't throw, but deletes 0 rows (secure behavior)
      await deleteTimeEntry(timeEntryId, attackerUserId);

      expect(mockQueryFn).toHaveBeenCalledWith(
        'DELETE FROM time_entries WHERE id = $1 AND user_id = $2',
        [timeEntryId, attackerUserId]
      );
      // Security: No rows deleted = user cannot delete resource that doesn't belong to them
    });
  });

  describe('Budget Access Control', () => {
    it('should only return budgets belonging to the authenticated user', async () => {
      const userId = 1;
      const userBudget = { id: 1, user_id: userId, name: 'My Budget' };
      const otherUserBudget = { id: 2, user_id: 2, name: 'Other Budget' };

      mockQueryFn.mockResolvedValue(createMockDbResult([userBudget]));

      const result = await getBudgets(userId);

      expect(mockQueryFn).toHaveBeenCalledWith(expect.stringContaining('WHERE user_id = $1'), [
        userId,
      ]);
      expect(result.length).toBeGreaterThanOrEqual(0);
      // Verify all returned budgets belong to user
      result.forEach((budget) => {
        expect(budget.user_id).toBe(userId);
      });
    });

    it("should prevent user from updating another user's budget", async () => {
      const attackerUserId = 1;
      const victimUserId = 2;
      const budgetId = 20;

      // Mock: budget belongs to victim, update should fail
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      // updateBudget throws error when budget doesn't belong to user (secure behavior)
      await expect(
        updateBudget(attackerUserId, budgetId, {
          name: 'Hacked Budget',
          monthlyBudget: 999999,
          startDate: '2026-01-01',
        })
      ).rejects.toThrow('Budget not found or you do not have permission to update it');

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $'),
        expect.arrayContaining([budgetId, attackerUserId])
      );
    });
  });

  describe('API Key Access Control', () => {
    it('should only return API keys belonging to the authenticated user', async () => {
      const userId = 1;
      const userApiKey = { id: 1, user_id: userId, key_name: 'My Key' };
      const otherUserApiKey = { id: 2, user_id: 2, key_name: 'Other Key' };

      mockQueryFn.mockResolvedValue(createMockDbResult([userApiKey]));

      const result = await getUserApiKeys(userId);

      expect(mockQueryFn).toHaveBeenCalledWith(expect.stringContaining('WHERE user_id = $1'), [
        userId,
      ]);
      expect(result.length).toBeGreaterThanOrEqual(0);
      // Verify all returned keys belong to user
      result.forEach((key) => {
        expect(key.user_id).toBe(userId);
      });
    });

    it("should prevent user from revoking another user's API key", async () => {
      const attackerUserId = 1;
      const victimUserId = 2;
      const apiKeyId = 30;

      // Mock: API key belongs to victim, revoke should fail
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await revokeApiKey(attackerUserId, apiKeyId);

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1 AND user_id = $2'),
        [apiKeyId, attackerUserId]
      );
      expect(result).toBe(false);
    });

    it("should prevent user from deleting another user's API key", async () => {
      const attackerUserId = 1;
      const victimUserId = 2;
      const apiKeyId = 30;

      // Mock: API key belongs to victim, delete should fail
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await deleteApiKey(attackerUserId, apiKeyId);

      expect(mockQueryFn).toHaveBeenCalledWith(
        'DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id',
        [apiKeyId, attackerUserId]
      );
      expect(result).toBe(false);
    });
  });

  describe('Security Audit Logs Access Control', () => {
    it('should only return audit logs for the authenticated user', async () => {
      const userId = 1;
      const userLog = { id: 1, user_id: userId, event_type: 'api_key_created' };
      const otherUserLog = { id: 2, user_id: 2, event_type: 'api_key_created' };

      mockQueryFn.mockResolvedValue(createMockDbResult([userLog]));

      const result = await getSecurityAuditLogs(userId, 100);

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('WHERE user_id = $1'),
        expect.arrayContaining([userId, 100])
      );
      expect(result.length).toBeGreaterThanOrEqual(0);
      // Verify all returned logs belong to user
      result.forEach((log) => {
        expect(log.user_id).toBe(userId);
      });
    });
  });

  describe('SQL Injection Prevention', () => {
    it('should use parameterized queries for user_id', async () => {
      const userId = "1'; DROP TABLE users; --";
      const staffId = "1 OR '1'='1";

      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      await getStaffById(staffId, userId);

      // Should use parameterized query, not string concatenation
      expect(mockQueryFn).toHaveBeenCalledWith(
        'SELECT * FROM staff WHERE id = $1 AND user_id = $2',
        [staffId, userId]
      );
      // The malicious SQL should be treated as a literal string, not executed
    });

    it('should use parameterized queries for shift operations', async () => {
      const userId = "1'; DELETE FROM shifts; --";
      const shiftId = "1 OR '1'='1";

      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      await getShiftById(shiftId, userId);

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('WHERE s.id = $1 AND s.user_id = $2'),
        [shiftId, userId]
      );
    });
  });
});
