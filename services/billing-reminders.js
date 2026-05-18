import { pool } from '../lib/db.js';
import { sendBillingReminderEmail } from '../lib/email.js';
import { createBillingPortalSession } from './stripe.js';

const REMINDER_DAYS = [7, 3, 1];

async function getUsersDueInDays(days) {
  const result = await pool.query(
    `SELECT id, email, name
     FROM users
     WHERE subscription_status IN ('paid', 'trial')
       AND subscription_end_date::date = (CURRENT_DATE + $1::int)
       AND NOT EXISTS (
         SELECT 1 FROM billing_reminder_log
         WHERE user_id = users.id
           AND days_before = $1
           AND sent_at::date = CURRENT_DATE
       )`,
    [days]
  );
  return result.rows;
}

async function ensureLogTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_reminder_log (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      days_before INTEGER NOT NULL,
      sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function runBillingReminders() {
  try {
    await ensureLogTable();

    let totalSent = 0;

    for (const days of REMINDER_DAYS) {
      const users = await getUsersDueInDays(days);

      for (const user of users) {
        try {
          let portalUrl = 'https://workalong.co.uk/plans';
          try {
            portalUrl = await createBillingPortalSession(user.id);
          } catch {
          }

          const renewalDate = new Date();
          renewalDate.setDate(renewalDate.getDate() + days);

          await sendBillingReminderEmail(
            user.email,
            user.name || 'there',
            days,
            renewalDate,
            portalUrl
          );

          await pool.query(
            `INSERT INTO billing_reminder_log (user_id, days_before) VALUES ($1, $2)`,
            [user.id, days]
          );

          totalSent++;
        } catch (err) {
          console.error(`[BillingReminder] Failed for user ${user.id}:`, err.message);
        }
      }
    }

    if (totalSent > 0) {
      console.log(`[BillingReminder] Sent ${totalSent} reminder email(s)`);
    }
  } catch (err) {
    console.error('[BillingReminder] Job failed:', err);
  }
}
