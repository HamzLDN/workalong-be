import { describe, it, expect } from '@jest/globals';
import {
  hammingDistance,
  maxAcceptableHammingDistance,
  verifyFaceHashAgainstHashes,
  findBestFaceMatchAmongStaff,
} from '../lib/faceHashMatch.js';

describe('faceHashMatch', () => {
  describe('hammingDistance', () => {
    it('returns 0 for identical strings', () => {
      expect(hammingDistance('abc', 'abc')).toBe(0);
    });

    it('counts differing characters', () => {
      expect(hammingDistance('abc', 'abd')).toBe(1);
      expect(hammingDistance('aaaa', 'bbbb')).toBe(4);
    });

    it('returns MAX_SAFE_INTEGER when lengths differ', () => {
      expect(hammingDistance('ab', 'a')).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('maxAcceptableHammingDistance', () => {
    it('is at least 10', () => {
      expect(maxAcceptableHammingDistance(32)).toBeGreaterThanOrEqual(10);
    });

    it('scales with length (28% floor)', () => {
      expect(maxAcceptableHammingDistance(100)).toBe(28);
    });
  });

  describe('verifyFaceHashAgainstHashes', () => {
    const good = 'a'.repeat(64);

    it('returns FACE_REQUIRED when hash is missing or too short', () => {
      expect(verifyFaceHashAgainstHashes('', [good])).toMatchObject({
        ok: false,
        reason: 'FACE_REQUIRED',
      });
      expect(verifyFaceHashAgainstHashes('x'.repeat(31), [good])).toMatchObject({
        ok: false,
        reason: 'FACE_REQUIRED',
      });
    });

    it('returns FACE_NOT_ENROLLED when no stored hashes', () => {
      expect(verifyFaceHashAgainstHashes(good, [])).toMatchObject({
        ok: false,
        reason: 'FACE_NOT_ENROLLED',
      });
      expect(verifyFaceHashAgainstHashes(good, null)).toMatchObject({
        ok: false,
        reason: 'FACE_NOT_ENROLLED',
      });
    });

    it('returns FACE_REENROLL_REQUIRED when stored hash lengths do not match incoming', () => {
      expect(verifyFaceHashAgainstHashes(good, ['short'])).toMatchObject({
        ok: false,
        reason: 'FACE_REENROLL_REQUIRED',
      });
    });

    it('returns ok when incoming matches a stored hash exactly', () => {
      const r = verifyFaceHashAgainstHashes(good, [good, 'b'.repeat(64)]);
      expect(r.ok).toBe(true);
      expect(r.reason).toBeNull();
      expect(r.bestDistance).toBe(0);
    });

    it('returns ok when within Hamming tolerance', () => {
      const stored = 'a'.repeat(64);
      const noisy = 'a'.repeat(63) + 'b';
      const r = verifyFaceHashAgainstHashes(noisy, [stored]);
      expect(r.ok).toBe(true);
    });

    it('returns FACE_MISMATCH when too far from all stored hashes', () => {
      const stored = 'a'.repeat(64);
      const far = 'b'.repeat(64);
      const r = verifyFaceHashAgainstHashes(far, [stored]);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('FACE_MISMATCH');
    });
  });

  describe('findBestFaceMatchAmongStaff', () => {
    const h64 = 'c'.repeat(64);

    it('returns null for short or empty input', () => {
      expect(findBestFaceMatchAmongStaff('', [])).toBeNull();
      expect(findBestFaceMatchAmongStaff('x'.repeat(31), [{ staff_id: 1, face_hashes: [h64], staff_name: 'A', clockin_id: '1' }])).toBeNull();
    });

    it('returns null when no rows', () => {
      expect(findBestFaceMatchAmongStaff(h64, [])).toBeNull();
    });

    it('returns null when no comparable hash lengths', () => {
      const rows = [
        { staff_id: 1, face_hashes: ['short'], staff_name: 'A', clockin_id: '111111' },
      ];
      expect(findBestFaceMatchAmongStaff(h64, rows)).toBeNull();
    });

    it('picks the staff with smallest Hamming distance when both match', () => {
      const exact = 'd'.repeat(64);
      const rows = [
        { staff_id: 1, face_hashes: [exact], staff_name: 'First', clockin_id: '111111' },
        {
          staff_id: 2,
          face_hashes: ['e'.repeat(64)],
          staff_name: 'Second',
          clockin_id: '222222',
        },
      ];
      const r = findBestFaceMatchAmongStaff(exact, rows);
      expect(r).toEqual({
        staffId: 1,
        staffName: 'First',
        clockinId: '111111',
      });
    });

    it('returns null when best distance still exceeds threshold', () => {
      const stored = 'f'.repeat(64);
      const rows = [{ staff_id: 1, face_hashes: [stored], staff_name: 'A', clockin_id: '1' }];
      const far = '0'.repeat(64);
      expect(findBestFaceMatchAmongStaff(far, rows)).toBeNull();
    });
  });
});
