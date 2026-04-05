/**
 * Face-API style 128-D L2-normalized face descriptors (Euclidean distance in embedding space).
 * More discriminative than the legacy 16×16 luminance bitstring hash.
 */

import { deriveClockinCode, splitStaffFirstLast } from './faceHashMatch.js';

export const FACE_EMBEDDING_DIM = 128;

/** Max L2 distance for verify (single staff, known code). Slightly looser than identify. */
export const VERIFY_MAX_L2_DISTANCE = 0.55;

/** Max L2 distance for best candidate in identify (among many staff). */
export const IDENTIFY_MAX_L2_DISTANCE = 0.48;

/** Minimum gap between 1st and 2nd best distance when multiple staff have embeddings. */
export function minIdentifyEmbeddingGap() {
  return 0.07;
}

/**
 * @param {unknown} v
 * @returns {number[]|null}
 */
export function normalizeEmbeddingArray(v) {
  if (!v) return null;
  if (Array.isArray(v) && v.length === FACE_EMBEDDING_DIM) {
    const out = v.map((x) => Number(x));
    return out.some((n) => Number.isNaN(n)) ? null : out;
  }
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p) && p.length === FACE_EMBEDDING_DIM) {
        const out = p.map((x) => Number(x));
        return out.some((n) => Number.isNaN(n)) ? null : out;
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function l2Distance(a, b) {
  if (!a || !b || a.length !== b.length || a.length !== FACE_EMBEDDING_DIM) {
    return Number.POSITIVE_INFINITY;
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * @param {number[]} live
 * @param {unknown} faceEmbeddings — JSONB: array of number[128]
 */
export function verifyEmbeddingAgainstStored(live, faceEmbeddings) {
  const incoming = normalizeEmbeddingArray(live);
  if (!incoming) return { ok: false, reason: 'FACE_REQUIRED' };

  const samples = Array.isArray(faceEmbeddings) ? faceEmbeddings : [];
  const comparable = samples.map((s) => normalizeEmbeddingArray(s)).filter(Boolean);
  if (comparable.length === 0) return { ok: false, reason: 'FACE_NOT_ENROLLED' };

  const best = comparable.reduce(
    (min, emb) => Math.min(min, l2Distance(incoming, emb)),
    Number.POSITIVE_INFINITY
  );
  const ok = best <= VERIFY_MAX_L2_DISTANCE;
  return {
    ok,
    bestDistance: best,
    reason: ok ? null : 'FACE_MISMATCH',
  };
}

/**
 * @param {number[]} live
 * @param {Array<{ staff_id: number, face_embeddings: unknown, staff_name: string, last_name?: string | null, clockin_id: string | null, username?: string | null }>} rows
 */
export function findBestEmbeddingMatchAmongStaff(live, rows) {
  const incoming = normalizeEmbeddingArray(live);
  if (!incoming) return null;
  if (!rows || rows.length === 0) return null;

  const maxIdent = IDENTIFY_MAX_L2_DISTANCE;
  const gapRequired = minIdentifyEmbeddingGap();

  const ranked = [];
  for (const row of rows) {
    const samples = Array.isArray(row.face_embeddings) ? row.face_embeddings : [];
    const comparable = samples.map((s) => normalizeEmbeddingArray(s)).filter(Boolean);
    if (comparable.length === 0) continue;

    const bestDistanceForStaff = comparable.reduce(
      (min, emb) => Math.min(min, l2Distance(incoming, emb)),
      Number.POSITIVE_INFINITY
    );
    const parts = splitStaffFirstLast(row.staff_name, row.last_name);
    ranked.push({
      staffId: row.staff_id,
      staffName: parts.full,
      staffFirstName: parts.first,
      staffLastName: parts.last,
      clockinCode: deriveClockinCode(row),
      distance: bestDistanceForStaff,
    });
  }

  ranked.sort((a, b) => a.distance - b.distance);
  const eligible = ranked.filter((c) => c.distance <= maxIdent);
  if (eligible.length === 0) return null;
  if (eligible.length >= 2 && eligible[1].distance - eligible[0].distance < gapRequired) {
    return null;
  }

  const best = eligible[0];
  return {
    staffId: best.staffId,
    staffName: best.staffName,
    staffFirstName: best.staffFirstName,
    staffLastName: best.staffLastName,
    clockinCode: best.clockinCode || null,
  };
}
