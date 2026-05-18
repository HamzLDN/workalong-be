import { pool } from './db.js';

/** Host labels that must never be assigned to an employer workspace. */
export const RESERVED_WORKSPACE_SLUGS = new Set([
  'www',
  'api',
  'ai',
  'dashboard',
  'admin',
  'app',
  'mail',
  'email',
  'ftp',
  'cdn',
  'static',
  'assets',
  'dev',
  'staging',
  'test',
  'demo',
  'support',
  'help',
  'status',
  'blog',
  'docs',
  'signin',
  'signup',
  'login',
  'auth',
  'staff',
  'clockin',
  'kiosk',
]);

const SLUG_MAX_LEN = 48;

export function slugifyWorkspaceName(input) {
  if (input == null || String(input).trim() === '') return '';
  let s = String(input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9]+/g, '-');
  s = s.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > SLUG_MAX_LEN) {
    s = s.slice(0, SLUG_MAX_LEN).replace(/-+$/g, '');
  }
  if (s.length < 3) return '';
  if (!/^[a-z0-9]/.test(s)) s = `co-${s}`;
  if (!/[a-z0-9]$/.test(s)) s = `${s}-co`;
  if (s.length > SLUG_MAX_LEN) s = s.slice(0, SLUG_MAX_LEN).replace(/-+$/g, '');
  return s;
}

export function isValidWorkspaceSlug(slug) {
  if (!slug || typeof slug !== 'string') return false;
  const s = slug.toLowerCase();
  if (s.length < 3 || s.length > SLUG_MAX_LEN) return false;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s)) return false;
  if (RESERVED_WORKSPACE_SLUGS.has(s)) return false;
  return true;
}

async function slugTaken(slug, excludeUserId = null) {
  const params = [slug];
  let sql = 'SELECT id FROM users WHERE workspace_slug = $1';
  if (excludeUserId != null) {
    sql += ' AND id <> $2';
    params.push(excludeUserId);
  }
  const r = await pool.query(sql, params);
  return r.rows.length > 0;
}

export async function generateUniqueWorkspaceSlug(preferredName, excludeUserId = null) {
  let base = slugifyWorkspaceName(preferredName);
  if (!base || RESERVED_WORKSPACE_SLUGS.has(base)) {
    base = `company-${Math.random().toString(36).slice(2, 8)}`;
  }

  if (!(await slugTaken(base, excludeUserId))) return base;

  for (let n = 2; n <= 200; n += 1) {
    const candidate = `${base.slice(0, Math.max(3, SLUG_MAX_LEN - String(n).length - 1))}-${n}`;
    if (isValidWorkspaceSlug(candidate) && !(await slugTaken(candidate, excludeUserId))) {
      return candidate;
    }
  }

  const fallback = `${base.slice(0, 20)}-${Math.random().toString(36).slice(2, 8)}`.slice(
    0,
    SLUG_MAX_LEN
  );
  if (!(await slugTaken(fallback, excludeUserId))) return fallback;
  throw new Error('Could not generate a unique workspace subdomain');
}

export async function assignWorkspaceSlugForUser(userId, companyOrName, { force = false } = {}) {
  const id = Number(userId);
  if (!Number.isFinite(id)) throw new Error('Invalid user id');

  const existing = await pool.query('SELECT workspace_slug, name FROM users WHERE id = $1', [id]);
  if (existing.rows.length === 0) throw new Error('User not found');
  const row = existing.rows[0];
  if (row.workspace_slug && !force) return row.workspace_slug;

  const slug = await generateUniqueWorkspaceSlug(companyOrName || row.name, id);
  await pool.query('UPDATE users SET workspace_slug = $1, updated_at = NOW() WHERE id = $2', [
    slug,
    id,
  ]);
  return slug;
}

export async function findUserIdByWorkspaceSlug(slug) {
  if (!isValidWorkspaceSlug(slug)) return null;
  const r = await pool.query('SELECT id FROM users WHERE workspace_slug = $1', [
    slug.toLowerCase(),
  ]);
  return r.rows[0]?.id ?? null;
}
