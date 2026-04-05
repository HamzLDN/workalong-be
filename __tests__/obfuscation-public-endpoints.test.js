import { describe, it, expect } from '@jest/globals';
import { isPublicEndpoint } from '../middleware/obfuscation.js';

describe('isPublicEndpoint (kiosk + Face ID)', () => {
  it('treats standard API face routes as public', () => {
    expect(isPublicEndpoint('/api/clockin/face/enroll')).toBe(true);
    expect(isPublicEndpoint('/api/clockin/face/verify')).toBe(true);
    expect(isPublicEndpoint('/api/clockin/face/identify')).toBe(true);
  });

  it('treats face routes as public when path has no /api (some proxies)', () => {
    expect(isPublicEndpoint('/clockin/face/enroll')).toBe(true);
  });

  it('treats face routes as public when a gateway adds a stage prefix', () => {
    expect(isPublicEndpoint('/prod/api/clockin/face/enroll')).toBe(true);
    expect(isPublicEndpoint('/v1/api/clockin/face/verify')).toBe(true);
  });

  it('does not mark unrelated clockin routes as public by substring mistake', () => {
    expect(isPublicEndpoint('/api/clockin/clock-action')).toBe(true); // explicit public endpoint
    expect(isPublicEndpoint('/api/clockin/evil-face-hack')).toBe(false);
  });
});
