import { describe, it, expect } from '@jest/globals';
import {
  hammingDistance,
  maxAcceptableHammingDistance,
  maxAcceptableHammingDistanceIdentify,
  verifyFaceHashAgainstHashes,
  findBestFaceMatchAmongStaff,
  formatStaffDisplayName,
  splitStaffFirstLast,
} from '../lib/faceHashMatch.js';

describe('faceHashMatch', () => {
  describe('splitStaffFirstLast', () => {
    it('uses DB lastname when set', () => {
      expect(splitStaffFirstLast('Dan', 'Smith')).toEqual({
        first: 'Dan',
        last: 'Smith',
        full: 'Dan Smith',
      });
    });

    it('splits single name field on first space when lastname column empty', () => {
      expect(splitStaffFirstLast('Dan Smith', null)).toEqual({
        first: 'Dan',
        last: 'Smith',
        full: 'Dan Smith',
      });
    });

    it('keeps single token as first only', () => {
      expect(splitStaffFirstLast('Dan', '')).toEqual({ first: 'Dan', last: '', full: 'Dan' });
    });
  });

  describe('formatStaffDisplayName', () => {
    it('joins first and last with a single space', () => {
      expect(formatStaffDisplayName('Chris', 'Jones')).toBe('Chris Jones');
    });

    it('returns first only when last is empty', () => {
      expect(formatStaffDisplayName('Chris', null)).toBe('Chris');
      expect(formatStaffDisplayName('Chris', '   ')).toBe('Chris');
    });

    it('trims parts', () => {
      expect(formatStaffDisplayName('  Ada  ', ' Lovelace ')).toBe('Ada Lovelace');
    });
  });

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
      expect(
        findBestFaceMatchAmongStaff('x'.repeat(31), [
          { staff_id: 1, face_hashes: [h64], staff_name: 'A', clockin_id: '1' },
        ])
      ).toBeNull();
    });

    it('returns null when no rows', () => {
      expect(findBestFaceMatchAmongStaff(h64, [])).toBeNull();
    });

    it('returns null when no comparable hash lengths', () => {
      const rows = [{ staff_id: 1, face_hashes: ['short'], staff_name: 'A', clockin_id: '111111' }];
      expect(findBestFaceMatchAmongStaff(h64, rows)).toBeNull();
    });

    it('splits staff.name on first space when last_name is absent (full name in one column)', () => {
      const exact = 'j'.repeat(64);
      const rows = [
        { staff_id: 1, face_hashes: [exact], staff_name: 'Dan Smith', clockin_id: '111111' },
      ];
      const r = findBestFaceMatchAmongStaff(exact, rows);
      expect(r).toEqual({
        staffId: 1,
        staffName: 'Dan Smith',
        staffFirstName: 'Dan',
        staffLastName: 'Smith',
        clockinCode: '111111',
      });
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
        staffFirstName: 'First',
        staffLastName: '',
        clockinCode: '111111',
      });
    });

    it('pads numeric clockin_id shorter than 6 digits (e.g. driver returns integer)', () => {
      const exact = 'h'.repeat(64);
      const rows = [
        {
          staff_id: 3,
          face_hashes: [exact],
          staff_name: 'Pat',
          last_name: 'Lee',
          clockin_id: 12345,
          username: null,
        },
      ];
      const r = findBestFaceMatchAmongStaff(exact, rows);
      expect(r).toEqual({
        staffId: 3,
        staffName: 'Pat Lee',
        staffFirstName: 'Pat',
        staffLastName: 'Lee',
        clockinCode: '012345',
      });
    });

    it('prefers username digits when they disagree with clockin_id (stale clockin_id)', () => {
      const exact = 'i'.repeat(64);
      const rows = [
        {
          staff_id: 9,
          face_hashes: [exact],
          staff_name: 'Dan',
          clockin_id: '999062',
          username: 'dan.411125',
        },
      ];
      const r = findBestFaceMatchAmongStaff(exact, rows);
      expect(r).toEqual({
        staffId: 9,
        staffName: 'Dan',
        staffFirstName: 'Dan',
        staffLastName: '',
        clockinCode: '411125',
      });
    });

    it('falls back to the last 6 digits of username when clockin_id is missing or malformed', () => {
      const exact = 'g'.repeat(64);
      const rows = [
        {
          staff_id: 1,
          face_hashes: [exact],
          staff_name: 'First',
          clockin_id: '1',
          username: 'first.411125',
        },
      ];
      const r = findBestFaceMatchAmongStaff(exact, rows);
      expect(r).toEqual({
        staffId: 1,
        staffName: 'First',
        staffFirstName: 'First',
        staffLastName: '',
        clockinCode: '411125',
      });
    });

    it('returns null when best distance still exceeds threshold', () => {
      const stored = 'f'.repeat(64);
      const rows = [{ staff_id: 1, face_hashes: [stored], staff_name: 'A', clockin_id: '1' }];
      const far = '0'.repeat(64);
      expect(findBestFaceMatchAmongStaff(far, rows)).toBeNull();
    });

    it('returns null when two enrolled staff are similarly close (ambiguous)', () => {
      const P = '0'.repeat(64);
      const H1 = '1'.repeat(5) + '0'.repeat(59);
      const H2 = '1'.repeat(6) + '0'.repeat(58);
      const rows = [
        { staff_id: 1, face_hashes: [H1], staff_name: 'A', clockin_id: '111111' },
        { staff_id: 2, face_hashes: [H2], staff_name: 'B', clockin_id: '222222' },
      ];
      expect(findBestFaceMatchAmongStaff(P, rows)).toBeNull();
    });

    it('returns the clear winner when the next-best match is much farther', () => {
      const P = '0'.repeat(64);
      const H1 = '1'.repeat(5) + '0'.repeat(59);
      const H2 = '1'.repeat(20) + '0'.repeat(44);
      const rows = [
        { staff_id: 1, face_hashes: [H1], staff_name: 'A', clockin_id: '111111' },
        { staff_id: 2, face_hashes: [H2], staff_name: 'B', clockin_id: '222222' },
      ];
      const r = findBestFaceMatchAmongStaff(P, rows);
      expect(r).toEqual({
        staffId: 1,
        staffName: 'A',
        staffFirstName: 'A',
        staffLastName: '',
        clockinCode: '111111',
      });
    });
  });

  describe('maxAcceptableHammingDistanceIdentify', () => {
    it('is stricter than verify for the same length', () => {
      const len = 256;
      expect(maxAcceptableHammingDistanceIdentify(len)).toBeLessThan(
        maxAcceptableHammingDistance(len)
      );
    });
  });
});
