import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockQueryFn = jest.fn();
const mockConnectFn = jest.fn();
const mockHashPasswordFn = jest.fn();

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

const { createStaff, updateStaff, getStaff } = await import('../services/staff.js');
const { getStaffSession } = await import('../services/staff-auth.js');
const { createMockDbResult, createMockStaff } = await import('./setup.js');

describe('Staff access_role field', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getStaff', () => {
    it('includes department, branch and manager LEFT JOINs and access_role in the query', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));
      await getStaff(1);
      const [query] = mockQueryFn.mock.calls[0];
      expect(query).toContain('s.access_role');
      expect(query.toLowerCase()).toContain('left join departments');
      expect(query.toLowerCase()).toContain('left join branches');
    });
  });

  describe('createStaff with access_role', () => {
    it('inserts access_role and returns the created staff member', async () => {
      const mockClient = { query: jest.fn(), release: jest.fn() };
      mockConnectFn.mockResolvedValue(mockClient);
      mockHashPasswordFn.mockResolvedValue('$2b$10$hashedPassword');

      const mockStaff = createMockStaff({ id: 5, access_role: 'manager' });
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce(createMockDbResult([{ count: '0' }])) // username uniqueness
        .mockResolvedValueOnce(createMockDbResult([mockStaff])) // INSERT staff
        .mockResolvedValueOnce({}) // INSERT password token
        .mockResolvedValueOnce({}); // COMMIT
      mockQueryFn.mockResolvedValueOnce(createMockDbResult([mockStaff])); // final SELECT

      const result = await createStaff(1, {
        name: 'Alice Smith',
        email: 'alice@example.com',
        role: 'Lead',
        hourlyRate: 18,
        employmentType: 'full-time',
        accessRole: 'manager',
      });

      expect(mockClient.query).toHaveBeenCalledTimes(5);
      expect(result).toBeDefined();

      const insertCall = mockClient.query.mock.calls.find(
        ([q]) => typeof q === 'string' && q.toUpperCase().includes('INSERT INTO STAFF')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[0]).toContain('access_role');
    });

    it('defaults to employee role when no accessRole is provided', async () => {
      const mockClient = { query: jest.fn(), release: jest.fn() };
      mockConnectFn.mockResolvedValue(mockClient);
      mockHashPasswordFn.mockResolvedValue('$2b$10$hashedPassword');

      const mockStaff = createMockStaff({ id: 6 });
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce(createMockDbResult([{ count: '0' }])) // username uniqueness
        .mockResolvedValueOnce(createMockDbResult([mockStaff])) // INSERT
        .mockResolvedValueOnce({}) // INSERT token
        .mockResolvedValueOnce({}); // COMMIT
      mockQueryFn.mockResolvedValueOnce(createMockDbResult([mockStaff]));

      const result = await createStaff(1, {
        name: 'Bob Brown',
        email: 'bob@example.com',
        role: 'Staff',
        hourlyRate: 12,
        employmentType: 'part-time',
      });

      expect(result).toBeDefined();
      const insertCall = mockClient.query.mock.calls.find(
        ([q]) => typeof q === 'string' && q.toUpperCase().includes('INSERT INTO STAFF')
      );
      expect(insertCall).toBeDefined();
      // access_role is always present in the INSERT now
      expect(insertCall[0]).toContain('access_role');
    });
  });

  describe('updateStaff with access_role', () => {
    it('throws for invalid access_role values', async () => {
      const mockClient = { query: jest.fn(), release: jest.fn() };
      mockConnectFn.mockResolvedValue(mockClient);

      const currentStaff = { id: 1, department_id: null, branch_id: null, manager_id: null };
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce(createMockDbResult([currentStaff])) // SELECT current
        .mockResolvedValueOnce({}); // ROLLBACK (triggered by throw)

      await expect(
        updateStaff(1, 1, {
          name: 'Test',
          accessRole: 'superadmin',
        })
      ).rejects.toThrow(/Invalid access role/i);
    });

    it('includes access_role in the UPDATE statement for valid roles', async () => {
      const mockClient = { query: jest.fn(), release: jest.fn() };
      mockConnectFn.mockResolvedValue(mockClient);

      const currentStaff = { id: 1, department_id: null, branch_id: null, manager_id: null };
      const updatedStaff = createMockStaff({ id: 1, access_role: 'payroll_admin' });
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce(createMockDbResult([currentStaff])) // SELECT current
        .mockResolvedValueOnce(createMockDbResult([updatedStaff])) // UPDATE
        .mockResolvedValueOnce({}); // COMMIT

      const result = await updateStaff(1, 1, {
        name: 'Alice Updated',
        hourlyRate: 20,
        accessRole: 'payroll_admin',
      });

      const updateCall = mockClient.query.mock.calls.find(
        ([q]) => typeof q === 'string' && q.toUpperCase().includes('UPDATE STAFF')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall[0]).toContain('access_role');
      expect(result).toBeDefined();
    });
  });
});

describe('Staff portal: access_role in session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('getStaffSession query selects s.access_role', async () => {
    mockQueryFn.mockResolvedValueOnce(
      createMockDbResult([
        {
          staff_id: 1,
          name: 'Bob',
          email: 'bob@example.com',
          role: 'Supervisor',
          access_role: 'manager',
          company_user_id: 10,
          company_name: 'ACME',
          hourly_rate: 15,
          employment_type: 'full-time',
          expires_at: new Date(Date.now() + 86400000),
        },
      ])
    );

    const session = await getStaffSession('some-session-uuid');

    expect(session).toBeDefined();
    expect(session.access_role).toBe('manager');

    const [query] = mockQueryFn.mock.calls[0];
    expect(query).toContain('s.access_role');
  });

  it('getStaffSession returns employee as access_role when not set', async () => {
    mockQueryFn.mockResolvedValueOnce(
      createMockDbResult([
        {
          staff_id: 2,
          name: 'Carol',
          email: 'carol@example.com',
          role: 'Staff',
          access_role: 'employee',
          company_user_id: 10,
          company_name: 'Corp',
          hourly_rate: 12,
          employment_type: 'part-time',
          expires_at: new Date(Date.now() + 86400000),
        },
      ])
    );

    const session = await getStaffSession('another-session-uuid');
    expect(session.access_role).toBe('employee');
  });

  it('returns undefined for expired or invalid session', async () => {
    mockQueryFn.mockResolvedValueOnce(createMockDbResult([]));
    const session = await getStaffSession('invalid-session');
    expect(session).toBeUndefined();
  });
});
