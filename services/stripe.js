import Stripe from 'stripe';
import { config } from '../lib/config.js';
import { pool } from '../lib/db.js';

// Initialize Stripe with your secret key
const stripeSecretKey = config.stripe?.secretKey || process.env.STRIPE_SECRET_KEY;
let stripe;

if (!stripeSecretKey || !String(stripeSecretKey).startsWith('sk_')) {
  console.warn('Stripe secret key missing or invalid; payment endpoints will fail.');
  // Use a properly formatted dummy test key to prevent Stripe initialization errors
  // Stripe test keys must match the format: sk_test_[at least 32 chars]
  // This allows the server to start but payment endpoints will fail gracefully with API errors
  const dummyKey = 'sk_test_51AbCdEfGhIjKlMnOpQrStUvWxYz1234567890AbCdEfGhIjKlMnOpQrStUvWxYz';
  console.warn('Using dummy Stripe key - payment endpoints will fail with API errors');
  stripe = new Stripe(dummyKey);
} else {
  stripe = new Stripe(stripeSecretKey);
}

export { stripe };

// Stripe Price IDs (created automatically)
const STRIPE_PRICE_IDS = {
  professional_monthly: 'price_1Sf90UIrkFfXWFRhinFt9vSh',
  professional_yearly: 'price_1Sf90VIrkFfXWFRhQEPBMUMR',
  enterprise_monthly: 'price_1Sf90VIrkFfXWFRhgnLBKoZD',
  enterprise_yearly: 'price_1Sf90VIrkFfXWFRhxGQSGWdS',
};

/**
 * Create a Checkout Session for subscription payment (fixed price ID)
 * @param {boolean} _retried - internal: true when retrying after clearing invalid customer
 */
export async function createCheckoutSession(userId, email, priceId, planName, _retried = false) {
  try {
    let customerId = await getStripeCustomerId(userId);
    
    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { userId: userId.toString() }
      });
      customerId = customer.id;
      await pool.query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, userId]
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        { price: priceId, quantity: 1 },
      ],
      success_url: `${process.env.FRONTEND_URL || 'https://workalong.co.uk'}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://workalong.co.uk'}/plans?canceled=true`,
      metadata: { userId: userId.toString(), planName },
      subscription_data: { metadata: { userId: userId.toString() } }
    });

    return session;
  } catch (error) {
    const isNoSuchCustomer = error.code === 'resource_missing' ||
      (error.message && String(error.message).includes('No such customer'));
    if (isNoSuchCustomer && !_retried) {
      await pool.query(
        'UPDATE users SET stripe_customer_id = NULL WHERE id = $1',
        [userId]
      );
      return createCheckoutSession(userId, email, priceId, planName, true);
    }
    console.error('Error creating checkout session:', error);
    throw error;
  }
}

/**
 * Create a Checkout Session with the calculated plan amount (dynamic pricing)
 * totalPrice is in GBP; Stripe expects amount in pence for GBP.
 * @param {boolean} _retried - internal: true when retrying after clearing invalid customer
 */
export async function createCheckoutSessionWithAmount(userId, email, planConfig, _retried = false) {
  const { totalPrice, billingCycle, staffCount, multiLocation, promoCode } = planConfig;

  if (!email || typeof email !== 'string' || !email.trim()) {
    throw new Error('Email is required for checkout');
  }
  const numPrice = Number(totalPrice);
  if (typeof numPrice !== 'number' || Number.isNaN(numPrice) || numPrice < 0) {
    throw new Error('Valid total price is required');
  }
  if (!billingCycle || !['monthly', 'yearly'].includes(billingCycle)) {
    throw new Error('Billing cycle must be monthly or yearly');
  }

  // Check active staff count - block if new limit is too low
  const newStaffLimit = parseInt(String(staffCount || 3), 10);
  const activeStaffResult = await pool.query(
    `SELECT COUNT(*) as count FROM staff 
     WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );
  const activeStaffCount = parseInt(activeStaffResult.rows[0]?.count || '0', 10);
  
  if (activeStaffCount > newStaffLimit) {
    throw new Error(
      `You have ${activeStaffCount} active staff members. ` +
      `Please deactivate ${activeStaffCount - newStaffLimit} staff before selecting a ${newStaffLimit}-staff plan.`
    );
  }
  
  try {
    let customerId = await getStripeCustomerId(userId);
    
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: email.trim(),
        metadata: { userId: userId.toString() }
      });
      customerId = customer.id;
      await pool.query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, userId]
      );
    }

    // Amount in pence (Stripe uses smallest currency unit for GBP)
    const amountPence = Math.round(numPrice * 100);
    if (amountPence < 50) {
      throw new Error('Minimum charge is £0.50');
    }

    const interval = billingCycle === 'yearly' ? 'year' : 'month';
    const productName = billingCycle === 'yearly'
      ? `Workalong Plan (Yearly) — £${numPrice.toFixed(2)}/year`
      : `Workalong Plan (Monthly) — £${numPrice.toFixed(2)}/month`;

    // Check if user already has an active subscription - cancel it first to avoid duplicates
    const existingSubResult = await pool.query(
      'SELECT stripe_subscription_id FROM users WHERE id = $1',
      [userId]
    );
    const existingSubId = existingSubResult.rows[0]?.stripe_subscription_id;
    if (existingSubId) {
      try {
        const existingSub = await stripe.subscriptions.retrieve(existingSubId);
        if (existingSub.status === 'active' || existingSub.status === 'trialing') {
          console.log(`[Checkout] Canceling existing subscription ${existingSubId} before creating new one`);
          await stripe.subscriptions.cancel(existingSubId);
        }
      } catch (e) {
        // Subscription might not exist in Stripe, ignore
        console.log(`[Checkout] Could not cancel existing subscription: ${e.message}`);
      }
    }

    // Optional: Stripe promotion code (for coupons/discounts)
    let stripePromotionCodeId = null;
    let is100PercentFreeForever = false;
    
    if (promoCode && String(promoCode).trim()) {
      try {
        // Promo codes are only allowed on monthly plans so they effectively give
        // at most one month of discount (first invoice). The actual "one month only"
        // behavior is controlled in Stripe by configuring the Coupon duration.
        if (billingCycle !== 'monthly') {
          throw new Error('Promo code can only be used with monthly billing.');
        }

        // Look up the promotion code by code string in the current Stripe mode (test/live)
        const promoList = await stripe.promotionCodes.list({
          code: String(promoCode).trim(),
          active: true,
          limit: 1,
        });

        if (!promoList.data || promoList.data.length === 0) {
          throw new Error('Invalid or expired promo code');
        }

        const promo = promoList.data[0];
        stripePromotionCodeId = promo.id;
        
        // Check if this is a 100% free forever promo code
        // Retrieve the coupon to check discount and duration
        // Handle both cases: coupon can be a string ID or an expanded object
        const couponId = typeof promo.coupon === 'string' ? promo.coupon : promo.coupon?.id;
        if (couponId) {
          try {
            const coupon = await stripe.coupons.retrieve(couponId);
            console.log(`[Checkout] Promo code ${promoCode} - Coupon details:`, {
              id: coupon.id,
              percent_off: coupon.percent_off,
              amount_off: coupon.amount_off,
              duration: coupon.duration,
              duration_in_months: coupon.duration_in_months,
              valid: coupon.valid
            });
            
            // Check for 100% free: either 100% percent_off, or amount_off that makes it free
            // For ANY 100% off promo code, remove trial period (not just "forever" ones)
            const is100PercentOff = coupon.percent_off === 100;
            const isForever = coupon.duration === 'forever' || (coupon.duration === 'repeating' && !coupon.duration_in_months);
            const makesItFree = coupon.amount_off && coupon.amount_off >= amountPence;
            
            // If it's 100% off (regardless of duration), treat as free and remove trial
            // This ensures "14 days free" doesn't show when the subscription is already free
            if (is100PercentOff || makesItFree) {
              is100PercentFreeForever = true;
              console.log(`[Checkout] ✅✅✅ DETECTED 100% OFF PROMO CODE: ${promoCode}`);
              console.log(`[Checkout] ✅✅✅ percent_off: ${coupon.percent_off}, duration: ${coupon.duration}, amount_off: ${coupon.amount_off}`);
              console.log(`[Checkout] ✅✅✅ NO TRIAL PERIOD WILL BE SET - SUBSCRIPTION STARTS IMMEDIATELY`);
            } else {
              console.log(`[Checkout] ❌ Promo code ${promoCode} is NOT 100% off:`);
              console.log(`[Checkout] ❌ percent_off: ${coupon.percent_off}, duration: ${coupon.duration}, amount_off: ${coupon.amount_off}`);
              console.log(`[Checkout] ❌ is100PercentOff: ${is100PercentOff}, makesItFree: ${makesItFree}`);
            }
          } catch (couponErr) {
            console.error(`[Checkout] Error retrieving coupon ${couponId}:`, couponErr.message);
          }
        } else {
          console.warn(`[Checkout] Could not get coupon ID from promo code ${promoCode}, coupon object:`, promo.coupon);
        }
      } catch (promoErr) {
        console.error('Error validating promo code with Stripe:', promoErr);
        throw promoErr;
      }
    }

    // 14-day free trial for first-time subscribers only (no previous subscription in our DB)
    // IMPORTANT: NEVER add trial period if using a 100% free forever promo code
    const firstTimeSubscriber = !existingSubId;
    const subscriptionData = {
      metadata: {
        userId: userId.toString(),
        planName: 'custom',
        staffCount: String(staffCount),
        multiLocation: multiLocation ? '1' : '0',
        billingCycle
      }
    };
    
    // CRITICAL: Only add trial period if:
    // 1. User is a first-time subscriber AND
    // 2. NOT using a 100% free forever promo code
    // For 100% free forever codes, subscription must start immediately with NO trial
    console.log(`[Checkout] Trial check - firstTimeSubscriber: ${firstTimeSubscriber}, is100PercentFreeForever: ${is100PercentFreeForever}, promoCode: ${promoCode || 'none'}`);
    
    // ABSOLUTELY NO TRIAL PERIOD for 100% free forever codes
    // This is CRITICAL - if free forever, NEVER set trial_period_days
    if (is100PercentFreeForever) {
      console.log(`[Checkout] 🚫🚫🚫 100% FREE FOREVER CODE - ABSOLUTELY NO TRIAL PERIOD`);
      console.log(`[Checkout] 🚫 subscriptionData will NOT have trial_period_days`);
      // DO NOTHING - don't set trial_period_days at all
      // This ensures Stripe doesn't show any trial information
    } else if (firstTimeSubscriber) {
      // Only add trial for first-time subscribers WITHOUT free forever codes
      subscriptionData.trial_period_days = 14;
      console.log(`[Checkout] ✅ Adding 14-day trial period for first-time subscriber`);
    } else {
      console.log(`[Checkout] ❌ Skipping trial period (not first-time subscriber)`);
    }
    
    // CRITICAL SAFETY CHECK: Remove trial_period_days if it exists for free forever codes
    if (is100PercentFreeForever) {
      if ('trial_period_days' in subscriptionData) {
        console.log(`[Checkout] ⚠️  CRITICAL ERROR: trial_period_days found for free forever code - DELETING NOW!`);
        delete subscriptionData.trial_period_days;
      }
      // Also explicitly set to undefined to be absolutely sure
      subscriptionData.trial_period_days = undefined;
      delete subscriptionData.trial_period_days;
      console.log(`[Checkout] ✅ Verified: trial_period_days removed from subscriptionData`);
    }

    // Build product description - exclude trial text for 100% free forever promo codes
    const trialText = (firstTimeSubscriber && !is100PercentFreeForever) ? '. 14-day free trial.' : '';
    const productDescription = `Staff: ${staffCount}, Multi-location: ${multiLocation ? 'Yes' : 'No'}${trialText}`;
    console.log(`[Checkout] Product description: "${productDescription}" (is100PercentFreeForever: ${is100PercentFreeForever}, firstTimeSubscriber: ${firstTimeSubscriber})`);

    // FINAL SAFETY CHECK: Ensure trial_period_days is NEVER in subscriptionData for free forever codes
    if (is100PercentFreeForever) {
      // Remove trial_period_days completely
      delete subscriptionData.trial_period_days;
      // Also ensure trial_settings is not set (newer Stripe API)
      delete subscriptionData.trial_settings;
      console.log(`[Checkout] ✅ Final check: subscriptionData.trial_period_days = ${subscriptionData.trial_period_days} (should be undefined)`);
      console.log(`[Checkout] ✅ Final subscription_data for free forever code:`, JSON.stringify(subscriptionData, null, 2));
    }
    
    console.log(`[Checkout] Creating checkout session with subscription_data:`, JSON.stringify(subscriptionData, null, 2));

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            unit_amount: amountPence,
            recurring: { interval },
            product_data: {
              name: productName,
              description: productDescription,
              metadata: {
                userId: userId.toString(),
                staffCount: String(staffCount),
                multiLocation: multiLocation ? '1' : '0',
                billingCycle
              }
            }
          },
          quantity: 1
        }
      ],
      success_url: `${process.env.FRONTEND_URL || 'https://workalong.co.uk'}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://workalong.co.uk'}/plans?canceled=true`,
      discounts: stripePromotionCodeId ? [{ promotion_code: stripePromotionCodeId }] : undefined,
      metadata: {
        userId: userId.toString(),
        planName: 'custom',
        staffCount: String(staffCount ?? 3),
        multiLocation: multiLocation ? '1' : '0',
        billingCycle,
        totalPrice: String(numPrice),
        promoCode: promoCode ? String(promoCode).trim() : ''
      },
      subscription_data: subscriptionData
    });

    return session;
  } catch (error) {
    const isNoSuchCustomer = error.code === 'resource_missing' ||
      (error.message && String(error.message).includes('No such customer'));
    if (isNoSuchCustomer && !_retried) {
      await pool.query(
        'UPDATE users SET stripe_customer_id = NULL WHERE id = $1',
        [userId]
      );
      return createCheckoutSessionWithAmount(userId, email, planConfig, true);
    }
    console.error('Error creating checkout session with amount:', error);
    if (error.type === 'StripeInvalidRequestError' && error.message) {
      throw new Error(error.message);
    }
    throw error;
  }
}

/**
 * Retrieve a Checkout Session by ID (for verify-session endpoint)
 */
export async function retrieveCheckoutSession(sessionId) {
  return stripe.checkout.sessions.retrieve(sessionId);
}

/**
 * Get Stripe customer ID for a user
 */
async function getStripeCustomerId(userId) {
  const result = await pool.query(
    'SELECT stripe_customer_id FROM users WHERE id = $1',
    [userId]
  );
  
  return result.rows[0]?.stripe_customer_id || null;
}

/**
 * Handle successful subscription payment
 */
export async function handleSubscriptionSuccess(session) {
  try {
    const metadata = session.metadata || {};
    const userId = parseInt(metadata.userId, 10);
    if (!userId || Number.isNaN(userId)) {
      throw new Error('Session metadata missing userId');
    }
    const subscriptionId = typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id;
    if (!subscriptionId) {
      throw new Error('Session has no subscription');
    }
    
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['discount.coupon']
    });
    const firstItem = subscription.items?.data?.[0];
    const planName = subscription.metadata?.planName
      || metadata.planName
      || (firstItem?.price?.id ? getPlanFromPriceId(firstItem.price.id) : 'custom');
    const staffLimit = parseInt(subscription.metadata?.staffCount || metadata.staffCount || '0', 10) || null;
    const multiLocationEnabled = (subscription.metadata?.multiLocation || metadata.multiLocation) === '1';
    const dbStatus = subscription.status === 'trialing' ? 'trial' : 'paid';
    
    // Extract discount percentage from subscription
    let discountPercent = null;
    if (subscription.discount && subscription.discount.coupon) {
      if (subscription.discount.coupon.percent_off) {
        discountPercent = subscription.discount.coupon.percent_off;
      } else if (subscription.discount.coupon.amount_off) {
        // For fixed amount discounts, we'd need to calculate percentage based on price
        // For now, store as 0 to indicate there's a discount but it's amount-based
        discountPercent = 0;
      }
    }
    
    // Try with subscription_staff_limit, multi_location_enabled, and subscription_discount_percent; if columns missing, retry without them
    try {
      await pool.query(
        `UPDATE users 
         SET 
           subscription_status = $1,
           subscription_plan = $2,
           subscription_start_date = to_timestamp($3),
           subscription_end_date = to_timestamp($4),
           payment_method = 'stripe',
           last_payment_date = NOW(),
           stripe_subscription_id = $5,
           subscription_staff_limit = $6,
           multi_location_enabled = $7,
           subscription_discount_percent = $8,
           updated_at = NOW()
         WHERE id = $9`,
        [
          dbStatus,
          planName,
          subscription.current_period_start,
          subscription.current_period_end,
          subscriptionId,
          staffLimit,
          multiLocationEnabled,
          discountPercent,
          userId
        ]
      );
    } catch (updateErr) {
      if (updateErr.code === '42703' || String(updateErr.message || '').includes('subscription_staff_limit') || String(updateErr.message || '').includes('multi_location_enabled') || String(updateErr.message || '').includes('subscription_discount_percent')) {
        console.log('Some subscription columns missing; trying without discount_percent');
        try {
          await pool.query(
            `UPDATE users 
             SET subscription_status = $1, subscription_plan = $2, subscription_start_date = to_timestamp($3),
                 subscription_end_date = to_timestamp($4), payment_method = 'stripe', last_payment_date = NOW(),
                 stripe_subscription_id = $5, subscription_staff_limit = $6, updated_at = NOW()
             WHERE id = $7`,
            [dbStatus, planName, subscription.current_period_start, subscription.current_period_end, subscriptionId, staffLimit, userId]
          );
        } catch (e2) {
          // Final fallback without staff_limit
          await pool.query(
            `UPDATE users 
             SET subscription_status = $1, subscription_plan = $2, subscription_start_date = to_timestamp($3),
                 subscription_end_date = to_timestamp($4), payment_method = 'stripe', last_payment_date = NOW(),
                 stripe_subscription_id = $5, updated_at = NOW()
             WHERE id = $6`,
            [dbStatus, planName, subscription.current_period_start, subscription.current_period_end, subscriptionId, userId]
          );
        }
      } else {
        throw updateErr;
      }
    }

    console.log(`Subscription activated for user ${userId}`);
    return true;
  } catch (error) {
    console.error('Error handling subscription success:', error);
    throw error;
  }
}

/**
 * Sync DB when subscription is updated (e.g. from billing portal, renewal)
 */
export async function handleSubscriptionUpdated(subscription) {
  try {
    const subscriptionId = subscription.id;
    const result = await pool.query(
      'SELECT id FROM users WHERE stripe_subscription_id = $1',
      [subscriptionId]
    );
    if (result.rows.length === 0) return;

    const userId = result.rows[0].id;
    const isCanceledOrScheduled = subscription.status === 'canceled' || subscription.cancel_at_period_end === true;
    const dbStatus = isCanceledOrScheduled || subscription.status === 'unpaid' || subscription.status === 'past_due'
      ? 'expired'
      : subscription.status === 'active'
        ? 'paid'
        : subscription.status === 'trialing'
          ? 'trial'
          : 'expired';

    const staffLimit = parseInt(subscription.metadata?.staffCount || '0', 10) || null;
    const multiLocationEnabled = subscription.metadata?.multiLocation === '1';
    const periodEnd = subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null;

    // Get discount percentage from subscription
    let discountPercent = null;
    if (subscription.discount && subscription.discount.coupon) {
      if (subscription.discount.coupon.percent_off) {
        discountPercent = subscription.discount.coupon.percent_off;
      }
    }

    try {
      await pool.query(
        `UPDATE users 
         SET subscription_status = $1,
             subscription_end_date = $2,
             subscription_staff_limit = $3,
             multi_location_enabled = $4,
             subscription_discount_percent = $5,
             updated_at = NOW()
         WHERE id = $6`,
        [dbStatus, periodEnd, staffLimit, multiLocationEnabled, discountPercent, userId]
      );
      console.log(`Subscription synced for user ${userId}: ${dbStatus}${discountPercent ? ` (${discountPercent}% discount)` : ''}`);
    } catch (e) {
      if (e.code === '42703' || String(e.message || '').includes('subscription_staff_limit') || String(e.message || '').includes('multi_location_enabled') || String(e.message || '').includes('subscription_discount_percent')) {
        try {
          await pool.query(
            `UPDATE users SET subscription_status = $1, subscription_end_date = $2, subscription_staff_limit = $3, subscription_discount_percent = $4, updated_at = NOW() WHERE id = $5`,
            [dbStatus, periodEnd, staffLimit, discountPercent, userId]
          );
          if (multiLocationEnabled) {
            await pool.query('UPDATE users SET multi_location_enabled = TRUE WHERE id = $1', [userId]);
          }
        } catch (e2) {
          await pool.query(
            `UPDATE users SET subscription_status = $1, subscription_end_date = $2, updated_at = NOW() WHERE id = $3`,
            [dbStatus, periodEnd, userId]
          );
        }
      } else throw e;
    }
    return true;
  } catch (error) {
    console.error('Error syncing subscription update:', error);
    throw error;
  }
}

/**
 * Handle subscription cancellation
 */
export async function handleSubscriptionCanceled(subscription) {
  try {
    const userId = parseInt(subscription.metadata.userId);
    
    await pool.query(
      `UPDATE users 
       SET 
         subscription_status = 'expired',
         subscription_end_date = NOW(),
         updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );

    console.log(`Subscription canceled for user ${userId}`);
    return true;
  } catch (error) {
    console.error('Error handling subscription cancellation:', error);
    throw error;
  }
}

/**
 * Cancel a subscription.
 * - If it's been less than 3 days since subscription_start_date, cancel immediately and refund latest payment.
 * - Otherwise, cancel at period end (no refund).
 */
export async function cancelSubscription(userId) {
  try {
    // Get user's subscription info
    const result = await pool.query(
      'SELECT stripe_subscription_id, subscription_start_date FROM users WHERE id = $1',
      [userId]
    );

    const row = result.rows[0];
    const subscriptionId = row?.stripe_subscription_id;
    const startDate = row?.subscription_start_date;

    if (!subscriptionId) {
      throw new Error('No active subscription found');
    }

    let eligibleForRefund = false;
    if (startDate) {
      const now = new Date();
      const startedAt = new Date(startDate);
      const diffMs = now.getTime() - startedAt.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      eligibleForRefund = diffDays <= 3;
    }

    if (eligibleForRefund) {
      // Try to refund the latest payment (if available)
      let paymentIntentId = null;
      try {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ['latest_invoice.payment_intent'],
        });

        if (subscription.latest_invoice) {
          if (typeof subscription.latest_invoice === 'string') {
            const invoice = await stripe.invoices.retrieve(subscription.latest_invoice);
            paymentIntentId = invoice.payment_intent;
          } else if (subscription.latest_invoice.payment_intent) {
            const pi = subscription.latest_invoice.payment_intent;
            paymentIntentId = typeof pi === 'string' ? pi : pi.id;
          }
        }

        if (paymentIntentId) {
          await stripe.refunds.create({
            payment_intent: paymentIntentId,
            reason: 'requested_by_customer',
          });
        } else {
          console.warn(
            `cancelSubscription: No payment_intent found to refund for subscription ${subscriptionId}`
          );
        }
      } catch (refundErr) {
        console.error('Error attempting refund during cancellation:', refundErr);
        // Continue with cancellation even if refund fails
      }

      // Cancel immediately
      await stripe.subscriptions.cancel(subscriptionId);

      await pool.query(
        `UPDATE users 
         SET subscription_status = 'expired',
             subscription_end_date = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [userId]
      );

      return { refunded: true };
    }

    // Not eligible for refund: cancel at period end (user keeps access until end of billing cycle)
    await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    return { refunded: false };
  } catch (error) {
    console.error('Error canceling subscription:', error);
    throw error;
  }
}

/**
 * Create a Stripe Billing Portal session URL for subscription management.
 * Lets users update payment method, view invoices, cancel subscription, etc.
 */
export async function createBillingPortalSession(userId) {
  try {
    console.log(`[Billing Portal] Creating session for user ${userId}`);
    const result = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [userId]
    );

    const customerId = result.rows[0]?.stripe_customer_id;
    console.log(`[Billing Portal] Customer ID: ${customerId || 'NOT FOUND'}`);

    if (!customerId) {
      throw new Error('No billing account found. Subscribe first to manage your subscription.');
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://workalong.co.uk';
    console.log(`[Billing Portal] Creating Stripe session for customer ${customerId}`);
    
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${frontendUrl}/plans`,
    });

    console.log(`[Billing Portal] Session created: ${session.url}`);
    return session.url;
  } catch (error) {
    console.error('[Billing Portal] Error:', error.message);
    if (error.type === 'StripeInvalidRequestError') {
      console.error('[Billing Portal] Stripe error details:', error.raw?.message || error.message);
    }
    throw error;
  }
}

/**
 * Update existing subscription with new plan (immediate, with proration)
 * Replaces old plan - Stripe credits unused time and charges prorated new amount
 */
export async function updateSubscription(userId, planConfig) {
  const { totalPrice, billingCycle, staffCount, multiLocation } = planConfig;

  const numPrice = Number(totalPrice);
  if (typeof numPrice !== 'number' || Number.isNaN(numPrice) || numPrice < 0) {
    throw new Error('Valid total price is required');
  }
  if (!billingCycle || !['monthly', 'yearly'].includes(billingCycle)) {
    throw new Error('Billing cycle must be monthly or yearly');
  }

  // Check active staff count - block downgrade if new limit is too low
  const newStaffLimit = parseInt(String(staffCount || 3), 10);
  const activeStaffResult = await pool.query(
    `SELECT COUNT(*) as count FROM staff 
     WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );
  const activeStaffCount = parseInt(activeStaffResult.rows[0]?.count || '0', 10);
  
  if (activeStaffCount > newStaffLimit) {
    throw new Error(
      `You have ${activeStaffCount} active staff members. ` +
      `Please deactivate ${activeStaffCount - newStaffLimit} staff before downgrading to a ${newStaffLimit}-staff plan.`
    );
  }

  const result = await pool.query(
    'SELECT stripe_subscription_id FROM users WHERE id = $1',
    [userId]
  );
  const subscriptionId = result.rows[0]?.stripe_subscription_id;

  if (!subscriptionId) {
    throw new Error('No active subscription found. Use checkout to subscribe.');
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['discount.promotion_code']
  });

  if (subscription.status === 'canceled' || subscription.cancel_at_period_end) {
    throw new Error('Subscription is canceled. Use checkout to start a new subscription.');
  }

  const item = subscription.items?.data?.[0];
  if (!item) {
    throw new Error('Subscription has no items');
  }

  // Check if subscription has an existing discount/coupon
  const existingDiscount = subscription.discount;
  let discountPercent = null;
  
  // Get discount percentage from subscription or database
  if (existingDiscount && existingDiscount.coupon) {
    if (existingDiscount.coupon.percent_off) {
      discountPercent = existingDiscount.coupon.percent_off;
    }
  } else {
    // Fallback: check database for stored discount percentage
    const userResult = await pool.query(
      'SELECT subscription_discount_percent FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows[0]?.subscription_discount_percent != null) {
      discountPercent = userResult.rows[0].subscription_discount_percent;
    }
  }

  // Calculate final amount based on discount percentage
  let finalAmountPence = Math.round(numPrice * 100);
  if (discountPercent != null && discountPercent > 0) {
    const discountAmount = Math.round(finalAmountPence * (discountPercent / 100));
    finalAmountPence = Math.max(0, finalAmountPence - discountAmount);
    console.log(`Applying ${discountPercent}% discount: £${(numPrice).toFixed(2)} → £${(finalAmountPence / 100).toFixed(2)}`);
  }

  if (finalAmountPence > 0 && finalAmountPence < 50) {
    throw new Error('Minimum charge is £0.50');
  }

  const interval = billingCycle === 'yearly' ? 'year' : 'month';

  // Create a new product for this plan (Stripe auto-created products can't be updated)
  const productName = billingCycle === 'yearly'
    ? `Workalong Plan (Yearly) — £${(finalAmountPence / 100).toFixed(2)}/year`
    : `Workalong Plan (Monthly) — £${(finalAmountPence / 100).toFixed(2)}/month`;
  
  const newProduct = await stripe.products.create({
    name: productName,
    description: `Staff: ${staffCount}, Multi-location: ${multiLocation ? 'Yes' : 'No'}`,
    metadata: {
      userId: userId.toString(),
      staffCount: String(staffCount),
      multiLocation: multiLocation ? '1' : '0',
      billingCycle
    }
  });
  const productId = newProduct.id;

  // Prepare subscription update
  const updateParams = {
    items: [{
      id: item.id,
      price_data: {
        currency: 'gbp',
        unit_amount: finalAmountPence,
        recurring: { interval },
        product: productId
      }
    }],
    proration_behavior: 'create_prorations',
    metadata: {
      userId: userId.toString(),
      planName: 'custom',
      staffCount: String(staffCount),
      multiLocation: multiLocation ? '1' : '0',
      billingCycle
    }
  };

  // Preserve existing discount if present
  if (existingDiscount && existingDiscount.coupon) {
    // Discount is automatically preserved by Stripe when updating subscription
    // But we can explicitly ensure it's maintained
    console.log(`Preserving existing discount: ${existingDiscount.coupon.id}`);
  }

  const updatedSubscription = await stripe.subscriptions.update(subscriptionId, updateParams);

  // Get discount percentage from updated subscription
  const updatedSubscriptionWithDiscount = await stripe.subscriptions.retrieve(updatedSubscription.id, {
    expand: ['discount.coupon']
  });
  let updatedDiscountPercent = null;
  if (updatedSubscriptionWithDiscount.discount && updatedSubscriptionWithDiscount.discount.coupon) {
    if (updatedSubscriptionWithDiscount.discount.coupon.percent_off) {
      updatedDiscountPercent = updatedSubscriptionWithDiscount.discount.coupon.percent_off;
    }
  }
  // If no discount in subscription but we had one before, preserve it
  if (updatedDiscountPercent == null && discountPercent != null) {
    updatedDiscountPercent = discountPercent;
  }

  // Sync our DB with new staff limit, multi_location, discount, and dates
  const staffLimit = parseInt(String(staffCount || 3), 10) || null;
  const multiLocationEnabled = !!multiLocation;
  try {
    await pool.query(
      `UPDATE users 
       SET subscription_plan = 'custom',
           subscription_start_date = to_timestamp($1),
           subscription_end_date = to_timestamp($2),
           subscription_staff_limit = $3,
           multi_location_enabled = $4,
           subscription_discount_percent = $5,
           last_payment_date = NOW(),
           updated_at = NOW()
       WHERE id = $6`,
      [
        updatedSubscription.current_period_start,
        updatedSubscription.current_period_end,
        staffLimit,
        multiLocationEnabled,
        updatedDiscountPercent,
        userId
      ]
    );
    } catch (e) {
    if (e.code === '42703' || (String(e.message || '').includes('subscription_staff_limit') || String(e.message || '').includes('multi_location_enabled') || String(e.message || '').includes('subscription_discount_percent'))) {
      try {
        await pool.query(
          `UPDATE users SET subscription_plan = 'custom', subscription_start_date = to_timestamp($1), subscription_end_date = to_timestamp($2), subscription_staff_limit = $3, subscription_discount_percent = $4, last_payment_date = NOW(), updated_at = NOW() WHERE id = $5`,
          [updatedSubscription.current_period_start, updatedSubscription.current_period_end, staffLimit, updatedDiscountPercent, userId]
        );
      } catch (e2) {
        // Final fallback without discount_percent
        await pool.query(
          `UPDATE users SET subscription_plan = 'custom', subscription_start_date = to_timestamp($1), subscription_end_date = to_timestamp($2), subscription_staff_limit = $3, last_payment_date = NOW(), updated_at = NOW() WHERE id = $4`,
          [updatedSubscription.current_period_start, updatedSubscription.current_period_end, staffLimit, userId]
        );
      }
      if (multiLocationEnabled) {
        try {
          await pool.query('UPDATE users SET multi_location_enabled = TRUE WHERE id = $1', [userId]);
        } catch (_) { /* column may not exist */ }
      }
    } else {
      throw e;
    }
  }

  // If proration created an invoice that needs payment (e.g. 3D Secure), return URL
  const latestInvoiceId = updatedSubscription.latest_invoice;
  let hostedInvoiceUrl = null;
  if (latestInvoiceId) {
    const invoice = typeof latestInvoiceId === 'string'
      ? await stripe.invoices.retrieve(latestInvoiceId)
      : latestInvoiceId;
    if (invoice?.status === 'open' && invoice.hosted_invoice_url) {
      hostedInvoiceUrl = invoice.hosted_invoice_url;
    }
  }

  console.log(`Subscription updated for user ${userId}: staff=${staffCount}, £${numPrice}/${interval}`);
  return {
    subscription: updatedSubscription,
    requiresAction: !!hostedInvoiceUrl,
    hostedInvoiceUrl: hostedInvoiceUrl || null
  };
}

/**
 * Get subscription details from Stripe
 */
export async function getSubscriptionDetails(userId) {
  try {
    const result = await pool.query(
      'SELECT stripe_subscription_id FROM users WHERE id = $1',
      [userId]
    );
    
    const subscriptionId = result.rows[0]?.stripe_subscription_id;
    
    if (!subscriptionId) {
      return null;
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return subscription;
  } catch (error) {
    console.error('Error getting subscription details:', error);
    return null;
  }
}

/**
 * Verify subscription status with Stripe API and update database
 * Returns current subscription status
 */
export async function verifySubscriptionStatus(userId) {
  try {
    // Get user's Stripe customer ID and subscription ID from database
    let result;
    try {
      result = await pool.query(
        `SELECT stripe_customer_id, stripe_subscription_id, subscription_status, subscription_staff_limit 
         FROM users 
         WHERE id = $1`,
        [userId]
      );
    } catch (colErr) {
      if (colErr.code === '42703' || (colErr.message && String(colErr.message).includes('subscription_staff_limit'))) {
        result = await pool.query(
          `SELECT stripe_customer_id, stripe_subscription_id, subscription_status 
           FROM users 
           WHERE id = $1`,
          [userId]
        );
        if (result.rows[0]) result.rows[0].subscription_staff_limit = null;
      } else {
        throw colErr;
      }
    }
    
    if (result.rows.length === 0) {
      return { 
        isActive: false, 
        status: 'free',
        subscription: null,
        staffLimit: null,
        multiLocation: false,
        message: 'User not found'
      };
    }
    
    const user = result.rows[0];
    const customerId = user.stripe_customer_id;
    const subscriptionId = user.stripe_subscription_id;
    
    // If no Stripe IDs, user is on free plan
    if (!customerId && !subscriptionId) {
      return { 
        isActive: false, 
        status: 'free',
        subscription: null,
        staffLimit: null,
        multiLocation: false,
        message: 'No Stripe subscription found'
      };
    }
    
    // Verify subscription with Stripe API
    let subscription = null;
    let isActive = false;
    let stripeStatus = 'free';
    let resolvedStaffLimit = user.subscription_staff_limit ?? null;
    
    if (subscriptionId) {
      try {
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
        stripeStatus = subscription.status; // active, canceled, past_due, etc.
        
        // Treat as active only if not canceled (and not set to cancel at period end)
        const isCanceledOrScheduled = subscription.status === 'canceled' || subscription.cancel_at_period_end === true;
        isActive = !isCanceledOrScheduled && (subscription.status === 'active' || subscription.status === 'trialing');
        
        // Sync staff limit from Stripe metadata (for existing subscriptions; column may not exist before migration)
        const staffLimitFromStripe = parseInt(subscription.metadata?.staffCount || '0', 10) || null;
        if (staffLimitFromStripe != null) {
          try {
            await pool.query(
              `UPDATE users SET subscription_staff_limit = $1 WHERE id = $2`,
              [staffLimitFromStripe, userId]
            );
            resolvedStaffLimit = staffLimitFromStripe;
          } catch (e) {
            if (e.code !== '42703' && !String(e.message || '').includes('subscription_staff_limit')) throw e;
          }
        }
        // Sync multi_location_enabled from Stripe metadata (fixes users who upgraded but DB wasn't updated)
        const multiLocationFromStripe = subscription.metadata?.multiLocation === '1';
        try {
          await pool.query(
            `UPDATE users SET multi_location_enabled = $1 WHERE id = $2`,
            [multiLocationFromStripe, userId]
          );
        } catch (e) {
          if (e.code !== '42703' && !String(e.message || '').includes('multi_location_enabled')) throw e;
        }
        
        // Update database with current Stripe status (treat cancel_at_period_end as expired)
        let dbStatus = 'free';
        if (isCanceledOrScheduled || subscription.status === 'canceled' || subscription.status === 'unpaid' || subscription.status === 'past_due') {
          dbStatus = 'expired';
        } else if (subscription.status === 'active') {
          dbStatus = 'paid';
        } else if (subscription.status === 'trialing') {
          dbStatus = 'trial';
        }
        // Update database if status changed
        if (user.subscription_status !== dbStatus) {
          await pool.query(
            `UPDATE users 
             SET subscription_status = $1,
                 subscription_end_date = $2
             WHERE id = $3`,
            [
              dbStatus,
              subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
              userId
            ]
          );
        }
      } catch (error) {
        // Subscription not found in Stripe (may have been deleted)
        if (error.code === 'resource_missing') {
          try {
            await pool.query(
              `UPDATE users SET subscription_status = 'expired', stripe_subscription_id = NULL WHERE id = $1`,
              [userId]
            );
          } catch (updateErr) {
            console.error('Update user after missing subscription:', updateErr);
          }
          return {
            isActive: false,
            status: 'expired',
            subscription: null,
            staffLimit: null,
            multiLocation: false,
            message: 'Subscription not found in Stripe'
          };
        }
        console.error('Stripe subscription retrieve error:', error);
        return { isActive: false, status: 'free', subscription: null, staffLimit: null, multiLocation: false, message: 'Could not verify subscription' };
      }
    } else if (customerId) {
      // Check if customer has any active subscriptions
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: 'active',
        limit: 1
      });
      
      if (subscriptions.data.length > 0) {
        subscription = subscriptions.data[0];
        stripeStatus = subscription.status;
        isActive = true;
        const staffLimitFromStripe = parseInt(subscription.metadata?.staffCount || '0', 10) || null;
        try {
          await pool.query(
            `UPDATE users 
             SET stripe_subscription_id = $1,
                 subscription_status = 'paid',
                 subscription_end_date = $2
             WHERE id = $3`,
            [
              subscription.id,
              subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
              userId
            ]
          );
          if (staffLimitFromStripe != null) {
            try {
              await pool.query(
                `UPDATE users SET subscription_staff_limit = $1 WHERE id = $2`,
                [staffLimitFromStripe, userId]
              );
              resolvedStaffLimit = staffLimitFromStripe;
            } catch (e) {
              if (e.code !== '42703') throw e;
            }
          }
        } catch (e) {
          if (e.code === '42703') {
            await pool.query(
              `UPDATE users SET stripe_subscription_id = $1, subscription_status = 'paid', subscription_end_date = $2 WHERE id = $3`,
              [subscription.id, subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null, userId]
            );
            if (staffLimitFromStripe != null) resolvedStaffLimit = staffLimitFromStripe;
          } else throw e;
        }
      }
    }
    
    const multiLocation = subscription?.metadata?.multiLocation === '1';
    return {
      isActive,
      status: stripeStatus,
      staffLimit: resolvedStaffLimit,
      multiLocation: multiLocation || false,
      subscription: subscription ? {
        id: subscription.id,
        status: subscription.status,
        currentPeriodStart: subscription.current_period_start,
        currentPeriodEnd: subscription.current_period_end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        plan: subscription.items?.data[0]?.price?.id || null
      } : null,
      message: isActive ? 'Active subscription found' : 'No active subscription'
    };
  } catch (error) {
    console.error('Error verifying subscription status:', error);
    return { isActive: false, status: 'free', subscription: null, staffLimit: null, multiLocation: false, message: 'Could not verify subscription' };
  }
}

/**
 * Helper: Map Stripe Price ID to plan name
 * TODO: Replace Price IDs with your actual ones from Stripe Dashboard
 */
function getPlanFromPriceId(priceId) {
  const priceToPlan = {
    [STRIPE_PRICE_IDS.professional_monthly]: 'professional',
    [STRIPE_PRICE_IDS.professional_yearly]: 'professional',
    [STRIPE_PRICE_IDS.enterprise_monthly]: 'enterprise',
    [STRIPE_PRICE_IDS.enterprise_yearly]: 'enterprise',
  };
  
  return priceToPlan[priceId] || 'professional';
}

/**
 * Verify Stripe webhook signature
 */
export function verifyWebhookSignature(payload, signature) {
  try {
    const webhookSecret = config.stripe?.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET;
    const event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    return event;
  } catch (error) {
    console.error('Webhook signature verification failed:', error);
    throw error;
  }
}

/**
 * Get Price ID based on plan and billing cycle
 */
export function getPriceId(plan, billingCycle) {
  const key = `${plan}_${billingCycle}`;
  return STRIPE_PRICE_IDS[key];
}

/**
 * Get payment reference numbers for a user (for proof of purchase)
 * Queries Stripe API directly to get all payment information
 */
export async function getPaymentReferenceNumbers(userId) {
  try {
    // Get user's Stripe customer ID and subscription ID from database
    const result = await pool.query(
      `SELECT stripe_customer_id, stripe_subscription_id 
       FROM users 
       WHERE id = $1`,
      [userId]
    );
    
    if (result.rows.length === 0 || !result.rows[0].stripe_customer_id) {
      return null;
    }
    
    const customerId = result.rows[0].stripe_customer_id;
    const subscriptionId = result.rows[0].stripe_subscription_id;
    
    // Get subscription details from Stripe with expanded invoice and payment intent
    let subscription = null;
    let latestInvoice = null;
    let paymentIntent = null;
    let checkoutSessions = [];
    
    if (subscriptionId) {
      subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['latest_invoice', 'latest_invoice.payment_intent']
      });
      
      latestInvoice = subscription.latest_invoice;
      if (typeof latestInvoice === 'string') {
        latestInvoice = await stripe.invoices.retrieve(latestInvoice);
      }
      
      if (latestInvoice?.payment_intent) {
        if (typeof latestInvoice.payment_intent === 'string') {
          paymentIntent = await stripe.paymentIntents.retrieve(latestInvoice.payment_intent);
        } else {
          paymentIntent = latestInvoice.payment_intent;
        }
      }
    }
    
    // Get checkout sessions for this customer
    if (customerId) {
      const sessions = await stripe.checkout.sessions.list({
        customer: customerId,
        limit: 10
      });
      checkoutSessions = sessions.data.filter(s => s.payment_status === 'paid');
    }
    
    // Return all reference numbers from Stripe
    return {
      customerId: customerId,
      subscriptionId: subscriptionId,
      // Most recent checkout session
      checkoutSessionId: checkoutSessions[0]?.id || null,
      // Latest invoice (primary reference for proof of purchase)
      invoiceId: latestInvoice?.id || null,
      invoiceNumber: latestInvoice?.number || null,
      // Payment intent
      paymentIntentId: paymentIntent?.id || null,
      // Subscription details
      subscriptionStatus: subscription?.status || null,
      subscriptionCurrentPeriodEnd: subscription?.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
      // Primary reference number (most useful for proof of purchase)
      primaryReference: latestInvoice?.number || latestInvoice?.id || subscriptionId || checkoutSessions[0]?.id || null,
      // All invoices for this subscription
      allInvoices: subscriptionId ? await getSubscriptionInvoices(subscriptionId) : []
    };
  } catch (error) {
    console.error('Error getting payment reference numbers from Stripe:', error);
    return null;
  }
}

/**
 * Get all invoices for a subscription
 */
async function getSubscriptionInvoices(subscriptionId) {
  try {
    const invoices = await stripe.invoices.list({
      subscription: subscriptionId,
      limit: 100
    });
    
    return invoices.data.map(invoice => ({
      id: invoice.id,
      number: invoice.number,
      amountPaid: invoice.amount_paid / 100, // Convert from cents
      currency: invoice.currency,
      status: invoice.status,
      created: new Date(invoice.created * 1000),
      paidAt: invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : null
    }));
  } catch (error) {
    console.error('Error getting subscription invoices:', error);
    return [];
  }
}

