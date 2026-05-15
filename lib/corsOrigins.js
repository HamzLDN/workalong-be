import { isValidWorkspaceSlug, RESERVED_WORKSPACE_SLUGS } from './workspaceSlug.js';

const DEFAULT_ROOT = 'workalong.co.uk';

export function getWorkspaceRootDomain() {
  return String(process.env.WORKSPACE_ROOT_DOMAIN || DEFAULT_ROOT)
    .toLowerCase()
    .replace(/^\./, '');
}

/**
 * True for https://{slug}.workalong.co.uk (employer tenant hosts), excluding reserved labels.
 */
export function isEmployerWorkspaceOrigin(origin) {
  if (!origin || typeof origin !== 'string') return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

  const root = getWorkspaceRootDomain();
  const host = url.hostname.toLowerCase();
  if (host === root || host === `www.${root}`) return false;
  if (!host.endsWith(`.${root}`)) return false;

  const slug = host.slice(0, -(root.length + 1));
  if (!slug || slug.includes('.')) return false;
  if (RESERVED_WORKSPACE_SLUGS.has(slug)) return false;
  return isValidWorkspaceSlug(slug);
}

/** Merge comma-separated ALLOWED_ORIGINS from env with built-in defaults. */
export function originsFromEnv() {
  const raw = process.env.ALLOWED_ORIGINS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
