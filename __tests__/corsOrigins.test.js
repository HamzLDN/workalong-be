import { describe, it, expect } from '@jest/globals';
import { isEmployerWorkspaceOrigin } from '../lib/corsOrigins.js';

describe('isEmployerWorkspaceOrigin', () => {
  it('allows tenant subdomains', () => {
    expect(isEmployerWorkspaceOrigin('https://david-smith.workalong.co.uk')).toBe(true);
  });

  it('rejects apex and reserved hosts', () => {
    expect(isEmployerWorkspaceOrigin('https://workalong.co.uk')).toBe(false);
    expect(isEmployerWorkspaceOrigin('https://dashboard.workalong.co.uk')).toBe(false);
    expect(isEmployerWorkspaceOrigin('https://api.workalong.co.uk')).toBe(false);
  });
});
