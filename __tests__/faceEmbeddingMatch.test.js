import { describe, it, expect } from '@jest/globals';
import {
  l2Distance,
  normalizeEmbeddingArray,
  verifyEmbeddingAgainstStored,
  findBestEmbeddingMatchAmongStaff,
  FACE_EMBEDDING_DIM,
} from '../lib/faceEmbeddingMatch.js';

function vec(seed) {
  const a = new Array(FACE_EMBEDDING_DIM);
  for (let i = 0; i < FACE_EMBEDDING_DIM; i++) {
    a[i] = Math.sin(seed + i * 0.1) * 0.5;
  }
  return a;
}

describe('faceEmbeddingMatch', () => {
  it('normalizeEmbeddingArray accepts length-128 arrays', () => {
    const v = vec(1);
    const n = normalizeEmbeddingArray(v);
    expect(n).toHaveLength(128);
  });

  it('l2Distance is 0 for identical vectors', () => {
    const v = vec(2);
    expect(l2Distance(v, v)).toBe(0);
  });

  it('verifyEmbeddingAgainstStored passes when close to a stored sample', () => {
    const a = vec(3);
    const noisy = a.map((x, i) => x + (i % 5) * 0.001);
    const r = verifyEmbeddingAgainstStored(noisy, [a]);
    expect(r.ok).toBe(true);
  });

  it('findBestEmbeddingMatchAmongStaff picks closer staff', () => {
    const live = vec(10);
    const s1 = vec(10);
    const s2 = vec(99);
    const rows = [
      {
        staff_id: 1,
        face_embeddings: [s1],
        staff_name: 'A',
        clockin_id: '111111',
        username: null,
      },
      {
        staff_id: 2,
        face_embeddings: [s2],
        staff_name: 'B',
        clockin_id: '222222',
        username: null,
      },
    ];
    const m = findBestEmbeddingMatchAmongStaff(live, rows);
    expect(m).not.toBeNull();
    expect(m.staffId).toBe(1);
  });
});
