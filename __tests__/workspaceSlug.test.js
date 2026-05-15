import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockQueryFn = jest.fn();

jest.unstable_mockModule('../lib/db.js', () => ({
  pool: { query: mockQueryFn },
  default: { query: mockQueryFn },
}));

const {
  slugifyWorkspaceName,
  isValidWorkspaceSlug,
  RESERVED_WORKSPACE_SLUGS,
  generateUniqueWorkspaceSlug,
} = await import('../lib/workspaceSlug.js');

describe('workspaceSlug', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('slugifyWorkspaceName', () => {
    it('slugifies company names', () => {
      expect(slugifyWorkspaceName('Acme Corp Ltd')).toBe('acme-corp-ltd');
      expect(slugifyWorkspaceName('Bob & Sons')).toBe('bob-and-sons');
    });

    it('rejects too-short results', () => {
      expect(slugifyWorkspaceName('AB')).toBe('');
    });
  });

  describe('isValidWorkspaceSlug', () => {
    it('accepts valid slugs', () => {
      expect(isValidWorkspaceSlug('acme-roofing')).toBe(true);
    });

    it('rejects reserved labels', () => {
      expect(isValidWorkspaceSlug('api')).toBe(false);
      expect(RESERVED_WORKSPACE_SLUGS.has('dashboard')).toBe(true);
    });
  });

  describe('generateUniqueWorkspaceSlug', () => {
    it('returns base when available', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [] });
      const slug = await generateUniqueWorkspaceSlug('Acme Roofing');
      expect(slug).toBe('acme-roofing');
    });

    it('appends suffix on collision', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValueOnce({ rows: [] });
      const slug = await generateUniqueWorkspaceSlug('Acme Roofing');
      expect(slug).toMatch(/^acme-roofing-\d+$/);
    });
  });
});
