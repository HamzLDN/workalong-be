import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Create mock functions that will be used
const mockQueryFn = jest.fn();
const mockHashFn = jest.fn();
const mockCompareFn = jest.fn();
const mockUuidv4Fn = jest.fn();

// Mock dependencies using unstable_mockModule for ES modules
jest.unstable_mockModule('../db.js', () => ({
  pool: {
    query: mockQueryFn,
    on: jest.fn(),
  },
}));

jest.unstable_mockModule('bcrypt', () => ({
  __esModule: true,
  default: {
    hash: mockHashFn,
    compare: mockCompareFn,
  },
}));

jest.unstable_mockModule('uuid', () => ({
  __esModule: true,
  v4: mockUuidv4Fn,
}));

// Now import modules using dynamic import (required for unstable_mockModule)
const {
  createUser,
  findUserByEmail,
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  deleteSession,
  cleanupExpiredSessions,
  createLoginCode,
  verifyLoginCode,
  createPasswordResetToken,
  verifyPasswordResetToken,
  resetPasswordWithToken,
} = await import('../auth.js');
const { pool } = await import('../db.js');
const bcrypt = await import('bcrypt');
const { v4: uuidv4 } = await import('uuid');
const { createMockDbResult, createMockUser, createMockSession } = await import('./setup.js');

describe('Auth Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryFn.mockClear();
    mockHashFn.mockClear();
    mockCompareFn.mockClear();
    mockUuidv4Fn.mockClear();
  });

  describe('createUser', () => {
    it('should create a new user with hashed password', async () => {
      const mockUser = createMockUser();
      mockHashFn.mockResolvedValue('$2b$10$hashedPassword');
      mockQueryFn.mockResolvedValue(createMockDbResult([mockUser]));

      const result = await createUser('test@example.com', 'password123', 'Test User');

      expect(mockHashFn).toHaveBeenCalledWith('password123', 10);
      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users'),
        expect.arrayContaining(['test@example.com', '$2b$10$hashedPassword', 'Test User'])
      );
      expect(result).toEqual(mockUser);
    });

    it('should handle company parameter (ignored)', async () => {
      const mockUser = createMockUser();
      mockHashFn.mockResolvedValue('$2b$10$hashedPassword');
      mockQueryFn.mockResolvedValue(createMockDbResult([mockUser]));

      await createUser('test@example.com', 'password123', 'Test User', 'Test Company');

      // Company parameter is accepted but not stored (no company column in users table)
      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users'),
        ['test@example.com', '$2b$10$hashedPassword', 'Test User']
      );
      // Verify company is NOT in the SQL query
      const callArgs = mockQueryFn.mock.calls[0];
      expect(callArgs[0]).not.toContain('company');
      expect(callArgs[1]).not.toContain('Test Company');
    });
  });

  describe('findUserByEmail', () => {
    it('should find user by email (case-insensitive)', async () => {
      const mockUser = createMockUser();
      mockQueryFn.mockResolvedValue(createMockDbResult([mockUser]));

      const result = await findUserByEmail('TEST@EXAMPLE.COM');

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('LOWER(email) = LOWER'),
        ['TEST@EXAMPLE.COM']
      );
      expect(result).toEqual(mockUser);
    });

    it('should return undefined if user not found', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await findUserByEmail('nonexistent@example.com');

      expect(result).toBeUndefined();
    });
  });

  describe('hashPassword', () => {
    it('should hash password with bcrypt', async () => {
      mockHashFn.mockResolvedValue('$2b$10$hashedPassword');

      const result = await hashPassword('password123');

      expect(mockHashFn).toHaveBeenCalledWith('password123', 10);
      expect(result).toBe('$2b$10$hashedPassword');
    });
  });

  describe('verifyPassword', () => {
    it('should verify correct password', async () => {
      mockCompareFn.mockResolvedValue(true);

      const result = await verifyPassword('password123', '$2b$10$hash');

      expect(mockCompareFn).toHaveBeenCalledWith('password123', '$2b$10$hash');
      expect(result).toBe(true);
    });

    it('should reject incorrect password', async () => {
      mockCompareFn.mockResolvedValue(false);

      const result = await verifyPassword('wrongpassword', '$2b$10$hash');

      expect(result).toBe(false);
    });
  });

  describe('createSession', () => {
    it('should create a new session', async () => {
      const mockSessionId = 'mock-session-id';
      mockUuidv4Fn.mockReturnValue(mockSessionId);
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await createSession(1, '127.0.0.1', 'test-agent');

      expect(mockUuidv4Fn).toHaveBeenCalled();
      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO sessions'),
        [mockSessionId, 1, expect.any(Date), '127.0.0.1', 'test-agent']
      );
      expect(result.sessionId).toBe(mockSessionId);
      expect(result.expiresAt).toBeInstanceOf(Date);
    });
  });

  describe('getSession', () => {
    it('should get valid session', async () => {
      const mockSession = createMockSession();
      mockQueryFn.mockResolvedValue(createMockDbResult([mockSession]));

      const result = await getSession('valid-session-id');

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('SELECT s.*, u.id as user_id'),
        ['valid-session-id']
      );
      expect(result).toEqual(mockSession);
    });

    it('should return undefined for expired session', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await getSession('expired-session-id');

      expect(result).toBeUndefined();
    });
  });

  describe('deleteSession', () => {
    it('should delete session', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      await deleteSession('session-id');

      expect(mockQueryFn).toHaveBeenCalledWith(
        'DELETE FROM sessions WHERE id = $1',
        ['session-id']
      );
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('should delete expired sessions', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      await cleanupExpiredSessions();

      expect(mockQueryFn).toHaveBeenCalledWith(
        'DELETE FROM sessions WHERE expires_at < NOW()'
      );
    });
  });

  describe('createLoginCode', () => {
    it('should create a 6-digit login code', async () => {
      const mockCode = {
        id: 1,
        code: '123456',
        email: 'test@example.com',
        expires_at: new Date(),
      };
      mockQueryFn
        .mockResolvedValueOnce(createMockDbResult([])) // DELETE existing codes
        .mockResolvedValueOnce(createMockDbResult([mockCode])); // INSERT new code

      const result = await createLoginCode(1, 'test@example.com');

      expect(mockQueryFn).toHaveBeenCalledTimes(2);
      expect(result.code).toMatch(/^\d{6}$/);
      expect(result.email).toBe('test@example.com');
    });
  });

  describe('verifyLoginCode', () => {
    it('should verify valid login code', async () => {
      const mockCode = {
        id: 1,
        code: '123456',
        user_id: 1,
        expires_at: new Date(Date.now() + 60000),
      };
      mockQueryFn
        .mockResolvedValueOnce(createMockDbResult([mockCode])) // SELECT code
        .mockResolvedValueOnce(createMockDbResult([])); // UPDATE used_at

      const result = await verifyLoginCode(1, '123456');

      expect(mockQueryFn).toHaveBeenCalledTimes(2);
      expect(result).toEqual(mockCode);
    });

    it('should return null for invalid code', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await verifyLoginCode(1, 'invalid');

      expect(result).toBeNull();
    });

    it('should return null for expired code', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await verifyLoginCode(1, '123456');

      expect(result).toBeNull();
    });
  });

  describe('createPasswordResetToken', () => {
    it('should create password reset token for existing user', async () => {
      const mockUser = createMockUser();
      const mockToken = {
        id: 1,
        token: 'reset-token',
        email: 'test@example.com',
        expires_at: new Date(),
      };
      mockQueryFn
        .mockResolvedValueOnce(createMockDbResult([mockUser])) // findUserByEmail
        .mockResolvedValueOnce(createMockDbResult([])) // DELETE existing tokens
        .mockResolvedValueOnce(createMockDbResult([mockToken])); // INSERT new token

      const result = await createPasswordResetToken('test@example.com');

      expect(result).toHaveProperty('token');
      expect(result).toHaveProperty('user');
      expect(result.user.email).toBe(mockUser.email);
    });

    it('should return null for non-existent user', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await createPasswordResetToken('nonexistent@example.com');

      expect(result).toBeNull();
    });
  });

  describe('verifyPasswordResetToken', () => {
    it('should verify valid reset token', async () => {
      const mockToken = {
        id: 1,
        token: 'valid-token',
        user_id: 1,
        email: 'test@example.com',
        expires_at: new Date(Date.now() + 3600000),
      };
      mockQueryFn.mockResolvedValue(createMockDbResult([mockToken]));

      const result = await verifyPasswordResetToken('valid-token');

      expect(result).toBeDefined();
      expect(result.token).toBe('valid-token');
    });

    it('should return null for invalid token', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await verifyPasswordResetToken('invalid-token');

      expect(result).toBeNull();
    });
  });

  describe('resetPasswordWithToken', () => {
    it('should reset password with valid token', async () => {
      const mockToken = {
        id: 1,
        token: 'valid-token',
        user_id: 1,
        expires_at: new Date(Date.now() + 3600000),
      };
      mockHashFn.mockResolvedValue('$2b$10$newHash');
      mockQueryFn
        .mockResolvedValueOnce(createMockDbResult([mockToken])) // verifyPasswordResetToken
        .mockResolvedValueOnce(createMockDbResult([])) // UPDATE password
        .mockResolvedValueOnce(createMockDbResult([])); // UPDATE token used_at

      const result = await resetPasswordWithToken('valid-token', 'newPassword123');

      expect(mockHashFn).toHaveBeenCalledWith('newPassword123', 10);
      expect(mockQueryFn).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ success: true });
    });

    it('should return null for invalid token', async () => {
      mockQueryFn.mockResolvedValue(createMockDbResult([]));

      const result = await resetPasswordWithToken('invalid-token', 'newPassword123');

      expect(result).toBeNull();
    });
  });
});
