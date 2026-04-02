/**
 * Pure face-hash comparison for kiosk Face ID (Hamming distance on fixed-length strings).
 * Used by clock-in routes for verify / identify flows.
 */

export function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return diff;
}

export function maxAcceptableHammingDistance(incomingLength) {
  return Math.max(10, Math.floor(incomingLength * 0.28));
}

/**
 * Compare a live face hash against stored hashes for one staff profile row.
 * @param {string} faceHash
 * @param {unknown} faceHashes — JSONB array from staff_face_profiles.face_hashes
 * @returns {{ ok: boolean, reason?: string, bestDistance?: number }}
 */
export function verifyFaceHashAgainstHashes(faceHash, faceHashes) {
  if (!faceHash || typeof faceHash !== 'string' || faceHash.length < 32) {
    return { ok: false, reason: 'FACE_REQUIRED' };
  }
  const hashes = Array.isArray(faceHashes) ? faceHashes : [];
  if (hashes.length === 0) return { ok: false, reason: 'FACE_NOT_ENROLLED' };

  const incoming = String(faceHash);
  const comparable = hashes.map((h) => String(h || '')).filter((h) => h.length === incoming.length);
  if (comparable.length === 0) return { ok: false, reason: 'FACE_REENROLL_REQUIRED' };

  const best = comparable.reduce(
    (min, h) => Math.min(min, hammingDistance(h, incoming)),
    Number.MAX_SAFE_INTEGER
  );
  const maxDistance = maxAcceptableHammingDistance(incoming.length);
  return {
    ok: best <= maxDistance,
    bestDistance: best,
    reason: best <= maxDistance ? null : 'FACE_MISMATCH',
  };
}

/**
 * Pick the best-matching active staff row for identify (no clock-in code).
 * @param {string} faceHash
 * @param {Array<{ staff_id: number, face_hashes: unknown, staff_name: string, clockin_id: string | null }>} rows
 * @returns {{ staffId: number, staffName: string, clockinId: string | null } | null}
 */
export function findBestFaceMatchAmongStaff(faceHash, rows) {
  const incoming = String(faceHash || '');
  if (!incoming || incoming.length < 32) return null;
  if (!rows || rows.length === 0) return null;

  let best = null;
  const maxDistance = maxAcceptableHammingDistance(incoming.length);

  for (const row of rows) {
    const hashes = Array.isArray(row.face_hashes) ? row.face_hashes : [];
    const comparable = hashes.map((h) => String(h || '')).filter((h) => h.length === incoming.length);
    if (comparable.length === 0) continue;
    const bestDistanceForStaff = comparable.reduce(
      (min, h) => Math.min(min, hammingDistance(h, incoming)),
      Number.MAX_SAFE_INTEGER
    );
    if (!best || bestDistanceForStaff < best.distance) {
      best = {
        staffId: row.staff_id,
        staffName: row.staff_name,
        clockinId: row.clockin_id,
        distance: bestDistanceForStaff,
      };
    }
  }

  if (!best || best.distance > maxDistance) return null;
  return {
    staffId: best.staffId,
    staffName: best.staffName,
    clockinId: best.clockinId || null,
  };
}
