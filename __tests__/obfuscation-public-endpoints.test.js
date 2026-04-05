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
});
