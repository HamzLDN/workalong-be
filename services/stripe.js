import Stripe from 'stripe';
import { config } from '../lib/config.js';
import { pool } from '../lib/db.js';
import { getTrialPeriodDays } from '../lib/appSettings.js';

const stripeSecretKey = config.stripe?.secretKey || process.env.STRIPE_SECRET_KEY;
let stripe;

if (!stripeSecretKey || !String(stripeSecretKey).startsWith('sk_')) {
  console.warn('Stripe secret key missing or invalid; payment endpoints will fail.');
  const dummyKey = 'sk_test_51AbCdEfGhIjKlMnOpQrStUvWxYz1234567890AbCdEfGhIjKlMnOpQrStUvWxYz';
  console.warn('Using dummy Stripe key - payment endpoints will fail with API errors');
  stripe = new Stripe(dummyKey);
} else {
  stripe = new Stripe(stripeSecretKey);
}

export { stripe };

const STRIPE_PRICE_IDS = {
  professional_monthly: 'price_1Sf90UIrkFfXWFRhinFt9vSh',
  professional_yearly: 'price_1Sf90VIrkFfXWFRhQEPBMUMR',
  enterprise_monthly: 'price_1Sf90VIrkFfXWFRhgnLBKoZD',
  enterprise_yearly: 'price_1Sf90VIrkFfXWFRhxGQSGWdS',
};

export async function createCheckoutSession(userId, email, priceId, planName, _retried = false) {
  try {
    let customerId = await getStripeCustomerId(userId);

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { userId: userId.toString() },
      });
      customerId = customer.id;
      await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [
        customerId,
        userId,
      ]);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL || 'https://workalong.co.uk'}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://workalong.co.uk'}/plans?canceled=true`,
      metadata: { userId: userId.toString(), planName },
      subscription_data: { metadata: { userId: userId.toString() } },
    });

    return session;
  } catch (error) {
    const isNoSuchCustomer =
      error.code === 'resource_missing' ||
      (error.message && String(error.message).includes('No such customer'));
    if (isNoSuchCustomer && !_retried) {
      await pool.query('UPDATE users SET stripe_customer_id = NULL WHERE id = $1', [userId]);
      return createCheckoutSession(userId, email, priceId, planName, true);
    }
    console.error('Error creating checkout session:', error);
    throw error;
  }
}

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
        metadata: { userId: userId.toString() },
      });
      customerId = customer.id;
      await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [
        customerId,
        userId,
      ]);
    }

    const amountPence = Math.round(numPrice * 100);
    if (amountPence < 50) {
      throw new Error('Minimum charge is £0.50');
    }

    const interval = billingCycle === 'yearly' ? 'year' : 'month';
    const productName =
      billingCycle === 'yearly'
        ? `Workalong Plan (Yearly) — £${numPrice.toFixed(2)}/year`
        : `Workalong Plan (Monthly) — £${numPrice.toFixed(2)}/month`;

    const existingSubResult = await pool.query(
      'SELECT stripe_subscription_id FROM users WHERE id = $1',
      [userId]
    );
    const existingSubId = existingSubResult.rows[0]?.stripe_subscription_id;
    if (existingSubId) {
      try {
        const existingSub = await stripe.subscriptions.retrieve(existingSubId);
        if (existingSub.status === 'active' || existingSub.status === 'trialing') {
          await stripe.subscriptions.cancel(existingSubId);
        }
      } catch (e) {
      }
    }

    let stripePromotionCodeId = null;
    let is100PercentFreeForever = false;

    if (promoCode && String(promoCode).trim()) {
      try {
        if (billingCycle !== 'monthly') {
          throw new Error('Promo code can only be used with monthly billing.');
        }

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

        const couponId = typeof promo.coupon === 'string' ? promo.coupon : promo.coupon?.id;
        if (couponId) {
          try {
            const coupon = await stripe.coupons.retrieve(couponId);

            const is100PercentOff = coupon.percent_off === 100;
            const isForever =
              coupon.duration === 'forever' ||
              (coupon.duration === 'repeating' && !coupon.duration_in_months);
            const makesItFree = coupon.amount_off && coupon.amount_off >= amountPence;

            if (is100PercentOff || makesItFree) {
              is100PercentFreeForever = true;
            } else {
            }
          } catch (couponErr) {
            console.error(`[Checkout] Error retrieving coupon ${couponId}:`, couponErr.message);
          }
        } else {
          console.warn(
            `[Checkout] Could not get coupon ID from promo code ${promoCode}, coupon object:`,
            promo.coupon
          );
        }
      } catch (promoErr) {
        console.error('Error validating promo code with Stripe:', promoErr);
        throw promoErr;
      }
    }

    const firstTimeSubscriber = !existingSubId;
    const subscriptionData = {
      metadata: {
        userId: userId.toString(),
        planName: 'custom',
        staffCount: String(staffCount),
        multiLocation: multiLocation ? '1' : '0',
        billingCycle,
      },
    };


    const hasPromoCode = stripePromotionCodeId !== null;
    const shouldRemoveTrialPeriod = is100PercentFreeForever || hasPromoCode;

    const trialDays = await getTrialPeriodDays();

    if (shouldRemoveTrialPeriod) {
    } else if (firstTimeSubscriber) {
      subscriptionData.trial_period_days = trialDays;
    } else {
    }

    if (shouldRemoveTrialPeriod) {
      if ('trial_period_days' in subscriptionData) {
        delete subscriptionData.trial_period_days;
      }
      subscriptionData.trial_period_days = undefined;
      delete subscriptionData.trial_period_days;
    }

    const trialText =
      firstTimeSubscriber && !shouldRemoveTrialPeriod ? `. ${trialDays}-day free trial.` : '';
    const productDescription = `Staff: ${staffCount}, Multi-location: ${multiLocation ? 'Yes' : 'No'}${trialText}`;

    if (shouldRemoveTrialPeriod) {
      delete subscriptionData.trial_period_days;
      delete subscriptionData.trial_settings;
    }


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
                billingCycle,
              },
            },
          },
          quantity: 1,
        },
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
        promoCode: promoCode ? String(promoCode).trim() : '',
      },
      subscription_data: subscriptionData,
    });

    return session;
  } catch (error) {
    const isNoSuchCustomer =
      error.code === 'resource_missing' ||
      (error.message && String(error.message).includes('No such customer'));
    if (isNoSuchCustomer && !_retried) {
      await pool.query('UPDATE users SET stripe_customer_id = NULL WHERE id = $1', [userId]);
      return createCheckoutSessionWithAmount(userId, email, planConfig, true);
    }
    console.error('Error creating checkout session with amount:', error);
    if (error.type === 'StripeInvalidRequestError' && error.message) {
      throw new Error(error.message);
    }
    throw error;
  }
}

export async function retrieveCheckoutSession(sessionId) {
  return stripe.checkout.sessions.retrieve(sessionId);
}

async function getStripeCustomerId(userId) {
  const result = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [userId]);

  return result.rows[0]?.stripe_customer_id || null;
}

export async function handleSubscriptionSuccess(session) {
  try {
    const metadata = session.metadata || {};
    const userId = parseInt(metadata.userId, 10);
    if (!userId || Number.isNaN(userId)) {
      throw new Error('Session metadata missing userId');
    }
    const subscriptionId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    if (!subscriptionId) {
      throw new Error('Session has no subscription');
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['discount.coupon'],
    });
    const firstItem = subscription.items?.data?.[0];
    const planName =
      subscription.metadata?.planName ||
      metadata.planName ||
      (firstItem?.price?.id ? getPlanFromPriceId(firstItem.price.id) : 'custom');
    const staffLimit =
      parseInt(subscription.metadata?.staffCount || metadata.staffCount || '0', 10) || null;
    const multiLocationEnabled =
      (subscription.metadata?.multiLocation || metadata.multiLocation) === '1';
    const dbStatus = subscription.status === 'trialing' ? 'trial' : 'paid';

    let discountPercent = null;
    if (subscription.discount && subscription.discount.coupon) {
      if (subscription.discount.coupon.percent_off) {
        discountPercent = subscription.discount.coupon.percent_off;
      } else if (subscription.discount.coupon.amount_off) {
        discountPercent = 0;
      }
    }

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
          userId,
        ]
      );
    } catch (updateErr) {
      if (
        updateErr.code === '42703' ||
        String(updateErr.message || '').includes('subscription_staff_limit') ||
        String(updateErr.message || '').includes('multi_location_enabled') ||
        String(updateErr.message || '').includes('subscription_discount_percent')
      ) {
        try {
          await pool.query(
            `UPDATE users 
             SET subscription_status = $1, subscription_plan = $2, subscription_start_date = to_timestamp($3),
                 subscription_end_date = to_timestamp($4), payment_method = 'stripe', last_payment_date = NOW(),
                 stripe_subscription_id = $5, subscription_staff_limit = $6, updated_at = NOW()
             WHERE id = $7`,
            [
              dbStatus,
              planName,
              subscription.current_period_start,
              subscription.current_period_end,
              subscriptionId,
              staffLimit,
              userId,
            ]
          );
        } catch (e2) {
          await pool.query(
            `UPDATE users 
             SET subscription_status = $1, subscription_plan = $2, subscription_start_date = to_timestamp($3),
                 subscription_end_date = to_timestamp($4), payment_method = 'stripe', last_payment_date = NOW(),
                 stripe_subscription_id = $5, updated_at = NOW()
             WHERE id = $6`,
            [
              dbStatus,
              planName,
              subscription.current_period_start,
              subscription.current_period_end,
              subscriptionId,
              userId,
            ]
          );
        }
      } else {
        throw updateErr;
      }
    }

    return true;
  } catch (error) {
    console.error('Error handling subscription success:', error);
    throw error;
  }
}

export async function handleSubscriptionUpdated(subscription) {
  try {
    const subscriptionId = subscription.id;
    const result = await pool.query('SELECT id FROM users WHERE stripe_subscription_id = $1', [
      subscriptionId,
    ]);
    if (result.rows.length === 0) return;

    const userId = result.rows[0].id;

    const dbStatus =
      subscription.status === 'canceled' ||
      subscription.status === 'unpaid' ||
      subscription.status === 'past_due'
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
    } catch (e) {
      if (
        e.code === '42703' ||
        String(e.message || '').includes('subscription_staff_limit') ||
        String(e.message || '').includes('multi_location_enabled') ||
        String(e.message || '').includes('subscription_discount_percent')
      ) {
        try {
          await pool.query(
            `UPDATE users SET subscription_status = $1, subscription_end_date = $2, subscription_staff_limit = $3, subscription_discount_percent = $4, updated_at = NOW() WHERE id = $5`,
            [dbStatus, periodEnd, staffLimit, discountPercent, userId]
          );
          if (multiLocationEnabled) {
            await pool.query('UPDATE users SET multi_location_enabled = TRUE WHERE id = $1', [
              userId,
            ]);
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

export async function handleInvoicePaymentSucceeded(invoice) {
  try {
    const subscriptionId =
      typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
    if (!subscriptionId) return;

    const result = await pool.query('SELECT id FROM users WHERE stripe_subscription_id = $1', [
      subscriptionId,
    ]);
    if (result.rows.length === 0) return;

    const userId = result.rows[0].id;

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const periodEnd = subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null;

    const dbStatus =
      subscription.status === 'trialing'
        ? 'trial'
        : subscription.status === 'active'
          ? 'paid'
          : null;

    if (dbStatus) {
      await pool.query(
        `UPDATE users 
         SET subscription_status = $1,
             subscription_end_date = $2,
             last_payment_date = NOW(),
             updated_at = NOW()
         WHERE id = $3`,
        [dbStatus, periodEnd, userId]
      );
    }
  } catch (error) {
    console.error('Error handling invoice payment succeeded:', error);
  }
}

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

    return true;
  } catch (error) {
    console.error('Error handling subscription cancellation:', error);
    throw error;
  }
}

export async function cancelSubscription(userId) {
  try {
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
      }

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

    await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    return { refunded: false };
  } catch (error) {
    console.error('Error canceling subscription:', error);
    throw error;
  }
}

export async function createBillingPortalSession(userId) {
  try {
    const result = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [userId]);

    const customerId = result.rows[0]?.stripe_customer_id;

    if (!customerId) {
      throw new Error('No billing account found. Subscribe first to manage your subscription.');
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://workalong.co.uk';

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${frontendUrl}/plans`,
    });

    return session.url;
  } catch (error) {
    console.error('[Billing Portal] Error:', error.message);
    if (error.type === 'StripeInvalidRequestError') {
      console.error('[Billing Portal] Stripe error details:', error.raw?.message || error.message);
    }
    throw error;
  }
}

export async function updateSubscription(userId, planConfig) {
  const { totalPrice, billingCycle, staffCount, multiLocation } = planConfig;

  const numPrice = Number(totalPrice);
  if (typeof numPrice !== 'number' || Number.isNaN(numPrice) || numPrice < 0) {
    throw new Error('Valid total price is required');
  }
  if (!billingCycle || !['monthly', 'yearly'].includes(billingCycle)) {
    throw new Error('Billing cycle must be monthly or yearly');
  }

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

  const result = await pool.query('SELECT stripe_subscription_id FROM users WHERE id = $1', [
    userId,
  ]);
  const subscriptionId = result.rows[0]?.stripe_subscription_id;

  if (!subscriptionId) {
    throw new Error('No active subscription found. Use checkout to subscribe.');
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['discount.promotion_code'],
  });

  if (subscription.status === 'canceled' || subscription.cancel_at_period_end) {
    throw new Error('Subscription is canceled. Use checkout to start a new subscription.');
  }

  const item = subscription.items?.data?.[0];
  if (!item) {
    throw new Error('Subscription has no items');
  }

  const existingDiscount = subscription.discount;
  let discountPercent = null;

  if (existingDiscount && existingDiscount.coupon) {
    if (existingDiscount.coupon.percent_off) {
      discountPercent = existingDiscount.coupon.percent_off;
    }
  } else {
    const userResult = await pool.query(
      'SELECT subscription_discount_percent FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows[0]?.subscription_discount_percent != null) {
      discountPercent = userResult.rows[0].subscription_discount_percent;
    }
  }

  let finalAmountPence = Math.round(numPrice * 100);
  if (discountPercent != null && discountPercent > 0) {
    const discountAmount = Math.round(finalAmountPence * (discountPercent / 100));
    finalAmountPence = Math.max(0, finalAmountPence - discountAmount);
  }

  if (finalAmountPence > 0 && finalAmountPence < 50) {
    throw new Error('Minimum charge is £0.50');
  }

  const interval = billingCycle === 'yearly' ? 'year' : 'month';

  const productName =
    billingCycle === 'yearly'
      ? `Workalong Plan (Yearly) — £${(finalAmountPence / 100).toFixed(2)}/year`
      : `Workalong Plan (Monthly) — £${(finalAmountPence / 100).toFixed(2)}/month`;

  const newProduct = await stripe.products.create({
    name: productName,
    description: `Staff: ${staffCount}, Multi-location: ${multiLocation ? 'Yes' : 'No'}`,
    metadata: {
      userId: userId.toString(),
      staffCount: String(staffCount),
      multiLocation: multiLocation ? '1' : '0',
      billingCycle,
    },
  });
  const productId = newProduct.id;

  const updateParams = {
    items: [
      {
        id: item.id,
        price_data: {
          currency: 'gbp',
          unit_amount: finalAmountPence,
          recurring: { interval },
          product: productId,
        },
      },
    ],
    proration_behavior: 'create_prorations',
    metadata: {
      userId: userId.toString(),
      planName: 'custom',
      staffCount: String(staffCount),
      multiLocation: multiLocation ? '1' : '0',
      billingCycle,
    },
  };

  if (existingDiscount && existingDiscount.coupon) {
  }

  const updatedSubscription = await stripe.subscriptions.update(subscriptionId, updateParams);

  const updatedSubscriptionWithDiscount = await stripe.subscriptions.retrieve(
    updatedSubscription.id,
    {
      expand: ['discount.coupon'],
    }
  );
  let updatedDiscountPercent = null;
  if (updatedSubscriptionWithDiscount.discount && updatedSubscriptionWithDiscount.discount.coupon) {
    if (updatedSubscriptionWithDiscount.discount.coupon.percent_off) {
      updatedDiscountPercent = updatedSubscriptionWithDiscount.discount.coupon.percent_off;
    }
  }
  if (updatedDiscountPercent == null && discountPercent != null) {
    updatedDiscountPercent = discountPercent;
  }

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
        userId,
      ]
    );
  } catch (e) {
    if (
      e.code === '42703' ||
      String(e.message || '').includes('subscription_staff_limit') ||
      String(e.message || '').includes('multi_location_enabled') ||
      String(e.message || '').includes('subscription_discount_percent')
    ) {
      try {
        await pool.query(
          `UPDATE users SET subscription_plan = 'custom', subscription_start_date = to_timestamp($1), subscription_end_date = to_timestamp($2), subscription_staff_limit = $3, subscription_discount_percent = $4, last_payment_date = NOW(), updated_at = NOW() WHERE id = $5`,
          [
            updatedSubscription.current_period_start,
            updatedSubscription.current_period_end,
            staffLimit,
            updatedDiscountPercent,
            userId,
          ]
        );
      } catch (e2) {
        await pool.query(
          `UPDATE users SET subscription_plan = 'custom', subscription_start_date = to_timestamp($1), subscription_end_date = to_timestamp($2), subscription_staff_limit = $3, last_payment_date = NOW(), updated_at = NOW() WHERE id = $4`,
          [
            updatedSubscription.current_period_start,
            updatedSubscription.current_period_end,
            staffLimit,
            userId,
          ]
        );
      }
      if (multiLocationEnabled) {
        try {
          await pool.query('UPDATE users SET multi_location_enabled = TRUE WHERE id = $1', [
            userId,
          ]);
        } catch (_) {
          /* column may not exist */
        }
      }
    } else {
      throw e;
    }
  }

  const latestInvoiceId = updatedSubscription.latest_invoice;
  let hostedInvoiceUrl = null;
  if (latestInvoiceId) {
    const invoice =
      typeof latestInvoiceId === 'string'
        ? await stripe.invoices.retrieve(latestInvoiceId)
        : latestInvoiceId;
    if (invoice?.status === 'open' && invoice.hosted_invoice_url) {
      hostedInvoiceUrl = invoice.hosted_invoice_url;
    }
  }

  return {
    subscription: updatedSubscription,
    requiresAction: !!hostedInvoiceUrl,
    hostedInvoiceUrl: hostedInvoiceUrl || null,
  };
}

export async function getSubscriptionDetails(userId) {
  try {
    const result = await pool.query('SELECT stripe_subscription_id FROM users WHERE id = $1', [
      userId,
    ]);

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

export async function verifySubscriptionStatus(userId) {
  try {
    let result;
    try {
      result = await pool.query(
        `SELECT stripe_customer_id, stripe_subscription_id, subscription_status, subscription_staff_limit, subscription_plan 
         FROM users 
         WHERE id = $1`,
        [userId]
      );
    } catch (colErr) {
      if (
        colErr.code === '42703' ||
        (colErr.message && String(colErr.message).includes('subscription_staff_limit'))
      ) {
        result = await pool.query(
          `SELECT stripe_customer_id, stripe_subscription_id, subscription_status, subscription_plan 
           FROM users 
           WHERE id = $1`,
          [userId]
        );
        if (result.rows[0]) {
          result.rows[0].subscription_staff_limit = null;
        }
      } else {
        throw colErr;
      }
    }

    if (result.rows.length === 0) {
      return {
        isActive: false,
        status: 'free',
        subscriptionPlan: 'free',
        subscription: null,
        staffLimit: null,
        multiLocation: false,
        message: 'User not found',
      };
    }

    const user = result.rows[0];
    const customerId = user.stripe_customer_id;
    const subscriptionId = user.stripe_subscription_id;

    if (!customerId && !subscriptionId) {
      return {
        isActive: false,
        status: 'free',
        subscriptionPlan: user.subscription_plan || 'free',
        subscription: null,
        staffLimit: null,
        multiLocation: false,
        message: 'No Stripe subscription found',
      };
    }

    let subscription = null;
    let isActive = false;
    let stripeStatus = 'free';
    let resolvedStaffLimit = user.subscription_staff_limit ?? null;

    if (subscriptionId) {
      try {
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
        stripeStatus = subscription.status; // active, canceled, past_due, etc.

        isActive =
          (subscription.status === 'active' || subscription.status === 'trialing') &&
          subscription.status !== 'canceled' &&
          subscription.status !== 'unpaid' &&
          subscription.status !== 'past_due';

        const staffLimitFromStripe = parseInt(subscription.metadata?.staffCount || '0', 10) || null;
        if (staffLimitFromStripe != null) {
          try {
            await pool.query(`UPDATE users SET subscription_staff_limit = $1 WHERE id = $2`, [
              staffLimitFromStripe,
              userId,
            ]);
            resolvedStaffLimit = staffLimitFromStripe;
          } catch (e) {
            if (e.code !== '42703' && !String(e.message || '').includes('subscription_staff_limit'))
              throw e;
          }
        }
        const multiLocationFromStripe = subscription.metadata?.multiLocation === '1';
        try {
          await pool.query(`UPDATE users SET multi_location_enabled = $1 WHERE id = $2`, [
            multiLocationFromStripe,
            userId,
          ]);
        } catch (e) {
          if (e.code !== '42703' && !String(e.message || '').includes('multi_location_enabled'))
            throw e;
        }

        let dbStatus = 'free';
        if (
          subscription.status === 'canceled' ||
          subscription.status === 'unpaid' ||
          subscription.status === 'past_due'
        ) {
          dbStatus = 'expired';
        } else if (subscription.status === 'active') {
          dbStatus = 'paid';
        } else if (subscription.status === 'trialing') {
          dbStatus = 'trial';
        }
        if (user.subscription_status !== dbStatus) {
          await pool.query(
            `UPDATE users 
             SET subscription_status = $1,
                 subscription_end_date = $2
             WHERE id = $3`,
            [
              dbStatus,
              subscription.current_period_end
                ? new Date(subscription.current_period_end * 1000)
                : null,
              userId,
            ]
          );
        }
      } catch (error) {
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
            subscriptionPlan: 'free',
            subscription: null,
            staffLimit: null,
            multiLocation: false,
            message: 'Subscription not found in Stripe',
          };
        }
        console.error('Stripe subscription retrieve error:', error);
        return {
          isActive: false,
          status: 'free',
          subscriptionPlan: 'free',
          subscription: null,
          staffLimit: null,
          multiLocation: false,
          message: 'Could not verify subscription',
        };
      }
    } else if (customerId) {
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: 'active',
        limit: 1,
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
              subscription.current_period_end
                ? new Date(subscription.current_period_end * 1000)
                : null,
              userId,
            ]
          );
          if (staffLimitFromStripe != null) {
            try {
              await pool.query(`UPDATE users SET subscription_staff_limit = $1 WHERE id = $2`, [
                staffLimitFromStripe,
                userId,
              ]);
              resolvedStaffLimit = staffLimitFromStripe;
            } catch (e) {
              if (e.code !== '42703') throw e;
            }
          }
        } catch (e) {
          if (e.code === '42703') {
            await pool.query(
              `UPDATE users SET stripe_subscription_id = $1, subscription_status = 'paid', subscription_end_date = $2 WHERE id = $3`,
              [
                subscription.id,
                subscription.current_period_end
                  ? new Date(subscription.current_period_end * 1000)
                  : null,
                userId,
              ]
            );
            if (staffLimitFromStripe != null) resolvedStaffLimit = staffLimitFromStripe;
          } else throw e;
        }
      }
    }

    const multiLocation = subscription?.metadata?.multiLocation === '1';
    const subscriptionPlan =
      user.subscription_plan ||
      subscription?.metadata?.planName ||
      (isActive ? 'professional' : 'free');
    return {
      isActive,
      status: stripeStatus,
      subscriptionPlan,
      staffLimit: resolvedStaffLimit,
      multiLocation: multiLocation || false,
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            currentPeriodStart: subscription.current_period_start,
            currentPeriodEnd: subscription.current_period_end,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            plan: subscription.items?.data[0]?.price?.id || null,
          }
        : null,
      message: isActive ? 'Active subscription found' : 'No active subscription',
    };
  } catch (error) {
    console.error('Error verifying subscription status:', error);
    return {
      isActive: false,
      status: 'free',
      subscriptionPlan: 'free',
      subscription: null,
      staffLimit: null,
      multiLocation: false,
      message: 'Could not verify subscription',
    };
  }
}

function getPlanFromPriceId(priceId) {
  const priceToPlan = {
    [STRIPE_PRICE_IDS.professional_monthly]: 'professional',
    [STRIPE_PRICE_IDS.professional_yearly]: 'professional',
    [STRIPE_PRICE_IDS.enterprise_monthly]: 'enterprise',
    [STRIPE_PRICE_IDS.enterprise_yearly]: 'enterprise',
  };

  return priceToPlan[priceId] || 'professional';
}

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

export function getPriceId(plan, billingCycle) {
  const key = `${plan}_${billingCycle}`;
  return STRIPE_PRICE_IDS[key];
}

export async function getPaymentReferenceNumbers(userId) {
  try {
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

    let subscription = null;
    let latestInvoice = null;
    let paymentIntent = null;
    let checkoutSessions = [];

    if (subscriptionId) {
      subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['latest_invoice', 'latest_invoice.payment_intent'],
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

    if (customerId) {
      const sessions = await stripe.checkout.sessions.list({
        customer: customerId,
        limit: 10,
      });
      checkoutSessions = sessions.data.filter((s) => s.payment_status === 'paid');
    }

    return {
      customerId: customerId,
      subscriptionId: subscriptionId,
      checkoutSessionId: checkoutSessions[0]?.id || null,
      invoiceId: latestInvoice?.id || null,
      invoiceNumber: latestInvoice?.number || null,
      paymentIntentId: paymentIntent?.id || null,
      subscriptionStatus: subscription?.status || null,
      subscriptionCurrentPeriodEnd: subscription?.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : null,
      primaryReference:
        latestInvoice?.number ||
        latestInvoice?.id ||
        subscriptionId ||
        checkoutSessions[0]?.id ||
        null,
      allInvoices: subscriptionId ? await getSubscriptionInvoices(subscriptionId) : [],
    };
  } catch (error) {
    console.error('Error getting payment reference numbers from Stripe:', error);
    return null;
  }
}

async function getSubscriptionInvoices(subscriptionId) {
  try {
    const invoices = await stripe.invoices.list({
      subscription: subscriptionId,
      limit: 100,
    });

    return invoices.data.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      amountPaid: invoice.amount_paid / 100, // Convert from cents
      currency: invoice.currency,
      status: invoice.status,
      created: new Date(invoice.created * 1000),
      paidAt: invoice.status_transitions?.paid_at
        ? new Date(invoice.status_transitions.paid_at * 1000)
        : null,
    }));
  } catch (error) {
    console.error('Error getting subscription invoices:', error);
    return [];
  }
}
