import { pool } from './db.js';

let ensured = false;

export async function ensureAppSettingsTable() {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const envDefault = process.env.SUBSCRIPTION_TRIAL_PERIOD_DAYS;
  const seed =
    envDefault && /^\d+$/.test(String(envDefault).trim()) ? String(parseInt(envDefault, 10)) : '14';
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('trial_period_days', $1)
     ON CONFLICT (key) DO NOTHING`,
    [seed]
  );
  ensured = true;
}

export async function getTrialPeriodDays() {
  try {
    await ensureAppSettingsTable();
    const r = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'trial_period_days' LIMIT 1`
    );
    if (r.rows[0]?.value != null) {
      const n = parseInt(String(r.rows[0].value).trim(), 10);
      if (Number.isFinite(n) && n >= 0 && n <= 730) return n;
    }
  } catch (e) {
    console.warn('[appSettings] getTrialPeriodDays DB error:', e.message);
  }
  const env = parseInt(process.env.SUBSCRIPTION_TRIAL_PERIOD_DAYS || '14', 10);
  return Number.isFinite(env) && env >= 0 && env <= 730 ? env : 14;
}
