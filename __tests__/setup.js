import { jest } from '@jest/globals';

// Helper function to create mock database query results
export function createMockDbResult(rows = []) {
  return {
    rows,
    rowCount: rows.length,
  };
}

// Helper function to create mock user objects
export function createMockUser(overrides = {}) {
  return {
    id: 1,
    email: 'test@example.com',
    name: 'Test User',
    password_hash: '$2b$10$mockHash',
    is_verified: true,
    subscription_status: 'active',
    subscription_plan: 'basic',
    created_at: new Date(),
    ...overrides,
  };
}

// Helper function to create mock staff objects
export function createMockStaff(overrides = {}) {
  return {
    id: 1,
    user_id: 1,
    name: 'John Doe',
    email: 'john@example.com',
    role: 'Manager',
    hourly_rate: 15.50,
    clockin_id: '123456',
    employment_type: 'full-time',
    is_active: true,
    created_at: new Date(),
    ...overrides,
  };
}

// Helper function to create mock shift objects
export function createMockShift(overrides = {}) {
  return {
    id: 1,
    user_id: 1,
    staff_id: 1,
    shift_date: '2026-02-05',
    start_time: '09:00:00',
    end_time: '17:00:00',
    hours: 8,
    break_minutes: 30,
    shift_type: 'regular',
    pay_type: 'regular',
    status: 'scheduled',
    location: null,
    notes: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// Helper function to create mock time entry objects
export function createMockTimeEntry(overrides = {}) {
  return {
    id: 1,
    staff_id: 1,
    user_id: 1,
    shift_id: 1,
    date: '2026-02-05',
    hours_worked: 8.0,
    overtime_hours: 0,
    notes: null,
    entry_type: 'clock',
    created_at: new Date(),
    ...overrides,
  };
}

// Helper function to create mock session objects
export function createMockSession(overrides = {}) {
  return {
    id: 'session-id',
    user_id: 1,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ip_address: '127.0.0.1',
    user_agent: 'test-agent',
    email: 'test@example.com',
    name: 'Test User',
    is_verified: true,
    subscription_status: 'active',
    subscription_plan: 'basic',
    ...overrides,
  };
}
