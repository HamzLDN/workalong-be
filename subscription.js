import { pool } from './db.js';

/**
 * Check if user has an active paid subscription
 */
export async function hasActiveSubscription(userId) {
  try {
    const result = await pool.query(
      `SELECT subscription_status, subscription_end_date 
       FROM users 
       WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return false;
    }

    const user = result.rows[0];
    
    // Check if user has paid or trial status
    if (user.subscription_status !== 'paid' && user.subscription_status !== 'trial') {
      return false;
    }

    // Check if subscription hasn't expired (if end date exists)
    if (user.subscription_end_date) {
      const endDate = new Date(user.subscription_end_date);
      const now = new Date();
      if (now > endDate) {
        // Subscription expired, update status
        await pool.query(
          `UPDATE users SET subscription_status = 'expired' WHERE id = $1`,
          [userId]
        );
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error('Error checking subscription:', error);
    return false;
  }
}

/**
 * Get user subscription details
 */
export async function getSubscriptionDetails(userId) {
  try {
    const result = await pool.query(
      `SELECT 
        subscription_status,
        subscription_plan,
        subscription_start_date,
        subscription_end_date,
        payment_method,
        last_payment_date
       FROM users 
       WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  } catch (error) {
    console.error('Error getting subscription details:', error);
    return null;
  }
}

/**
 * Update user subscription
 */
export async function updateSubscription(userId, subscriptionData) {
  const {
    status,
    plan,
    startDate,
    endDate,
    paymentMethod
  } = subscriptionData;

  try {
    const result = await pool.query(
      `UPDATE users 
       SET 
         subscription_status = $1,
         subscription_plan = $2,
         subscription_start_date = $3,
         subscription_end_date = $4,
         payment_method = $5,
         last_payment_date = NOW(),
         updated_at = NOW()
       WHERE id = $6
       RETURNING id, email, subscription_status, subscription_plan`,
      [status, plan, startDate, endDate, paymentMethod, userId]
    );

    return result.rows[0];
  } catch (error) {
    console.error('Error updating subscription:', error);
    throw error;
  }
}

/**
 * Middleware to check if user has paid subscription
 */
export async function requirePaidSubscription(req, res, next) {
  try {
    const hasPaid = await hasActiveSubscription(req.userId);
    
    if (!hasPaid) {
      return res.status(403).json({
        error: 'This feature requires a paid subscription',
        code: 'SUBSCRIPTION_REQUIRED'
      });
    }
    
    next();
  } catch (error) {
    console.error('Subscription check error:', error);
    res.status(500).json({ error: 'Failed to verify subscription' });
  }
}
