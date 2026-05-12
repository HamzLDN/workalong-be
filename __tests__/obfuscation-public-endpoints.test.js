import { describe, it, expect } from '@jest/globals';
import { isPublicEndpoint } from '../middleware/obfuscation.js';

describe('isPublicEndpoint', () => {
  it('does not treat Face ID routes as public (they use full obfuscation + link headers)', () => {
    expect(isPublicEndpoint('/api/clockin/face/enroll')).toBe(false);
    expect(isPublicEndpoint('/api/clockin/face/verify')).toBe(false);
    expect(isPublicEndpoint('/api/clockin/face/identify')).toBe(false);
    expect(isPublicEndpoint('/clockin/face/enroll')).toBe(false);
  });

  it('still treats kiosk clock-action and verify-link/status as public', () => {
    expect(isPublicEndpoint('/api/clockin/clock-action')).toBe(true);
    expect(isPublicEndpoint('/api/clockin/verify-link/tok')).toBe(true);
    expect(isPublicEndpoint('/api/clockin/status/tok')).toBe(true);
  });

  it('does not mark arbitrary clockin paths as public', () => {
    expect(isPublicEndpoint('/api/clockin/evil-face-hack')).toBe(false);
  });

  it('treats admin support-chat API paths as public (real handler is on admin-panel-api)', () => {
    expect(isPublicEndpoint('/api/support/chat/messages')).toBe(true);
  });

  it('treats /support/... (nginx alias to admin) as public when misrouted to this backend', () => {
    expect(isPublicEndpoint('/support/chat/messages')).toBe(true);
  });

  it('treats staff auth login and logout as public (no employer session at that point)', () => {
    expect(isPublicEndpoint('/api/staff/auth/login')).toBe(true);
    expect(isPublicEndpoint('/staff/auth/login')).toBe(true);
    expect(isPublicEndpoint('/api/staff/auth/logout')).toBe(true);
    expect(isPublicEndpoint('/staff/auth/logout')).toBe(true);
  });

  it('treats staff set-password as public (token-based, no session)', () => {
    expect(isPublicEndpoint('/api/staff/set-password')).toBe(true);
    expect(isPublicEndpoint('/staff/set-password')).toBe(true);
  });

  it('treats staff portal routes as public (use staff session cookie, not employer obfuscation)', () => {
    expect(isPublicEndpoint('/api/staff/portal/team')).toBe(true);
    expect(isPublicEndpoint('/staff/portal/team')).toBe(true);
    expect(isPublicEndpoint('/api/staff/portal/anything')).toBe(true);
  });

  it('does NOT treat arbitrary staff routes as public', () => {
    expect(isPublicEndpoint('/api/staff')).toBe(false);
    expect(isPublicEndpoint('/api/staff/1')).toBe(false);
    expect(isPublicEndpoint('/api/staff/stats')).toBe(false);
  });

  it('treats demo booking and contact as public (plain JSON, no signed transport)', () => {
    expect(isPublicEndpoint('/api/demo-booking')).toBe(true);
    expect(isPublicEndpoint('/demo-booking')).toBe(true);
    expect(isPublicEndpoint('/api/contact')).toBe(true);
  });

  it('treats trailing-slash variants as public (proxies often normalize URLs)', () => {
    expect(isPublicEndpoint('/api/demo-booking/')).toBe(true);
    expect(isPublicEndpoint('/api/contact/')).toBe(true);
  });
});
