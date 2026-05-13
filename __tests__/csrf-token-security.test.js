import { describe, it, expect } from '@jest/globals';
import { legacyDeterministicCsrfToken } from '../lib/csrfSession.js';

describe('CSRF token helpers (security)', () => {
  it('legacyDeterministicCsrfToken is deterministic for the same session', () => {
    const sid = '550e8400-e29b-41d4-a716-446655440000';
    const a = legacyDeterministicCsrfToken(sid);
    const b = legacyDeterministicCsrfToken(sid);
    expect(a).toBe(b);
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(32);
  });

  it('legacyDeterministicCsrfToken differs across session IDs', () => {
    const t1 = legacyDeterministicCsrfToken('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    const t2 = legacyDeterministicCsrfToken('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(t1).not.toBe(t2);
  });
});
