import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockQueryFn = jest.fn();

jest.unstable_mockModule('../lib/db.js', () => ({
  pool: {
    query: mockQueryFn,
    on: jest.fn(),
  },
}));

const { default: clockinRouter } = await import('../routes/clockin.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/clockin', clockinRouter);
  return app;
}

const app = buildApp();
const FP = 'device-fp-test';
const HASH64 = 'a'.repeat(64);
const LINK_TOKEN = 'test-link-token';

const linkRow = {
  id: 1,
  user_id: 7,
  link_token: LINK_TOKEN,
  device_fingerprint: FP,
  is_active: true,
};

function mockFaceFlowSuccess() {
  mockQueryFn.mockImplementation((sql) => {
    const s = String(sql).replace(/\s+/g, ' ');
    if (s.includes('FROM device_links') && s.includes('link_token')) {
      return Promise.resolve({ rows: [linkRow] });
    }
    if (
      s.includes('FROM staff') &&
      s.includes('staff_id') &&
      s.includes('clockin_id') &&
      !s.includes('staff_face_profiles')
    ) {
      return Promise.resolve({
        rows: [{ staff_id: 42, staff_name: 'Alex', user_id: 7 }],
      });
    }
    if (s.includes('staff_face_profiles') && s.includes('face_hashes')) {
      return Promise.resolve({ rows: [{ face_hashes: [HASH64] }] });
    }
    if (s.includes('UPDATE device_links')) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('clockin Face ID routes (integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryFn.mockReset();
  });

  describe('POST /api/clockin/face/enroll', () => {
    it('returns 400 when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/clockin/face/enroll')
        .set('X-Device-Fingerprint', FP)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/required/i);
    });

    it('returns 404 when link token is invalid', async () => {
      mockQueryFn.mockResolvedValue({ rows: [] });

      const res = await request(app)
        .post('/api/clockin/face/enroll')
        .set('X-Device-Fingerprint', FP)
        .send({
          clockinId: '123456',
          linkToken: 'bad',
          faceHash: HASH64,
        });

      expect(res.status).toBe(404);
    });

    it('returns 200 and enrolls when link and staff resolve', async () => {
      mockQueryFn.mockImplementation((sql) => {
        const s = String(sql).replace(/\s+/g, ' ');
        if (s.includes('FROM device_links') && s.includes('link_token')) {
          return Promise.resolve({ rows: [linkRow] });
        }
        if (s.includes('staff_face_profiles') && s.includes('SELECT face_hashes')) {
          return Promise.resolve({ rows: [] });
        }
        if (s.includes('INSERT INTO staff_face_profiles')) {
          return Promise.resolve({ rows: [] });
        }
        if (s.includes('FROM staff') && s.includes('clockin_id')) {
          return Promise.resolve({
            rows: [{ staff_id: 42, staff_name: 'Alex', user_id: 7 }],
          });
        }
        if (s.includes('UPDATE device_links')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await request(app)
        .post('/api/clockin/face/enroll')
        .set('X-Device-Fingerprint', FP)
        .send({
          clockinId: '123456',
          linkToken: LINK_TOKEN,
          faceHash: HASH64,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /api/clockin/face/verify', () => {
    it('returns 400 when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/clockin/face/verify')
        .set('X-Device-Fingerprint', FP)
        .send({ linkToken: LINK_TOKEN });

      expect(res.status).toBe(400);
    });

    it('returns 403 on device fingerprint mismatch', async () => {
      mockQueryFn.mockResolvedValue({
        rows: [{ ...linkRow, device_fingerprint: 'other-fp' }],
      });

      const res = await request(app)
        .post('/api/clockin/face/verify')
        .set('X-Device-Fingerprint', FP)
        .send({
          clockinId: '123456',
          linkToken: LINK_TOKEN,
          faceHash: HASH64,
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('DEVICE_MISMATCH');
    });

    it('returns 200 when face matches enrolled hash', async () => {
      mockFaceFlowSuccess();

      const res = await request(app)
        .post('/api/clockin/face/verify')
        .set('X-Device-Fingerprint', FP)
        .send({
          clockinId: '123456',
          linkToken: LINK_TOKEN,
          faceHash: HASH64,
        });

      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(true);
      expect(res.body.staffId).toBe(42);
      expect(res.body.staffName).toBe('Alex');
    });

    it('returns 403 FACE_NOT_ENROLLED when no profile', async () => {
      mockQueryFn.mockImplementation((sql) => {
        const s = String(sql).replace(/\s+/g, ' ');
        if (s.includes('FROM device_links') && s.includes('link_token')) {
          return Promise.resolve({ rows: [linkRow] });
        }
        if (s.includes('FROM staff') && s.includes('clockin_id')) {
          return Promise.resolve({
            rows: [{ staff_id: 42, staff_name: 'Alex', user_id: 7 }],
          });
        }
        if (s.includes('staff_face_profiles') && s.includes('face_hashes')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await request(app)
        .post('/api/clockin/face/verify')
        .set('X-Device-Fingerprint', FP)
        .send({
          clockinId: '123456',
          linkToken: LINK_TOKEN,
          faceHash: HASH64,
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FACE_NOT_ENROLLED');
    });
  });

  describe('POST /api/clockin/face/identify', () => {
    it('returns 400 when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/clockin/face/identify')
        .set('X-Device-Fingerprint', FP)
        .send({ linkToken: LINK_TOKEN });

      expect(res.status).toBe(400);
    });

    it('returns identified:false when no match', async () => {
      mockQueryFn.mockImplementation((sql) => {
        const s = String(sql).replace(/\s+/g, ' ');
        if (s.includes('FROM device_links') && s.includes('link_token')) {
          return Promise.resolve({ rows: [linkRow] });
        }
        if (s.includes('staff_face_profiles') && s.includes('JOIN staff')) {
          return Promise.resolve({
            rows: [
              {
                staff_id: 1,
                face_hashes: ['b'.repeat(64)],
                staff_name: 'Bob',
                clockin_id: '999999',
              },
            ],
          });
        }
        if (s.includes('UPDATE device_links')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await request(app)
        .post('/api/clockin/face/identify')
        .set('X-Device-Fingerprint', FP)
        .send({
          linkToken: LINK_TOKEN,
          faceHash: HASH64,
        });

      expect(res.status).toBe(200);
      expect(res.body.identified).toBe(false);
    });

    it('returns identified:true when a staff hash matches', async () => {
      mockQueryFn.mockImplementation((sql) => {
        const s = String(sql).replace(/\s+/g, ' ');
        if (s.includes('FROM device_links') && s.includes('link_token')) {
          return Promise.resolve({ rows: [linkRow] });
        }
        if (s.includes('staff_face_profiles') && s.includes('JOIN staff')) {
          return Promise.resolve({
            rows: [
              {
                staff_id: 5,
                face_hashes: [HASH64],
                staff_name: 'Chris',
                clockin_id: '555555',
              },
            ],
          });
        }
        if (s.includes('UPDATE device_links')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await request(app)
        .post('/api/clockin/face/identify')
        .set('X-Device-Fingerprint', FP)
        .send({
          linkToken: LINK_TOKEN,
          faceHash: HASH64,
        });

      expect(res.status).toBe(200);
      expect(res.body.identified).toBe(true);
      expect(res.body.staffId).toBe(5);
      expect(res.body.staffName).toBe('Chris');
    });
  });
});
