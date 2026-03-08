import express from 'express';
import { config } from '../lib/config.js';
import { pool } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.post('/create-checkout-session', requireAuth, async (req, res) => {
  try {
    const { totalPrice, billingCycle, staffCount, multiLocation, promoCode } = req.body;
    if (totalPrice == null || totalPrice < 0) {
      return res.status(400).json({ error: 'Valid total price is required' });
    }
    if (!billingCycle || !['monthly', 'yearly'].includes(billingCycle)) {
      return res.status(400).json({ error: 'Billing cycle must be monthly or yearly' });
    }
    let email = req.user?.email;
    if (!email || typeof email !== 'string') {
      const userRow = await pool.query('SELECT email FROM users WHERE id = $1', [req.userId]);
      email = userRow.rows[0]?.email;
    }
    if (!email || !email.trim()) {
      return res
        .status(400)
        .json({ error: 'Account email is required for checkout. Please complete your profile.' });
    }
    const { createCheckoutSessionWithAmount } = await import('../services/stripe.js');
    const session = await createCheckoutSessionWithAmount(req.userId, email.trim(), {
      totalPrice: parseFloat(totalPrice),
      billingCycle,
      staffCount: staffCount || 3,
      multiLocation: !!multiLocation,
      promoCode: promoCode ? String(promoCode).trim() : undefined,
    });
    res.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    console.error('Create checkout session error:', error);
    const message = error.message || error.raw?.message || 'Failed to create checkout session';
    res.status(500).json({ error: message });
  }
});

router.post('/update-subscription', requireAuth, async (req, res) => {
  try {
    const { totalPrice, billingCycle, staffCount, multiLocation } = req.body;
    if (totalPrice == null || totalPrice < 0) {
      return res.status(400).json({ error: 'Valid total price is required' });
    }
    if (!billingCycle || !['monthly', 'yearly'].includes(billingCycle)) {
      return res.status(400).json({ error: 'Billing cycle must be monthly or yearly' });
    }
    const { updateSubscription } = await import('../services/stripe.js');
    const result = await updateSubscription(req.userId, {
      totalPrice: parseFloat(totalPrice),
      billingCycle,
      staffCount: staffCount || 3,
      multiLocation: !!multiLocation,
    });
    if (result.requiresAction && result.hostedInvoiceUrl) {
      return res.json({
        success: true,
        requiresAction: true,
        url: result.hostedInvoiceUrl,
        message: 'Please complete payment to confirm your plan change',
      });
    }
    res.json({
      success: true,
      requiresAction: false,
      message: 'Subscription updated successfully. Your new plan is active.',
    });
  } catch (error) {
    console.error('Update subscription error:', error);
    const message = error.message || error.raw?.message || 'Failed to update subscription';
    res.status(500).json({ error: message });
  }
});

router.post('/verify-session', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    const { retrieveCheckoutSession, handleSubscriptionSuccess, getPaymentReferenceNumbers } =
      await import('../services/stripe.js');
    const session = await retrieveCheckoutSession(sessionId);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment not completed' });
    }
    const subscriptionId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    if (!subscriptionId) {
      return res.status(400).json({ error: 'No subscription found' });
    }
    const userIdFromSession = session.metadata?.userId
      ? parseInt(session.metadata.userId, 10)
      : null;
    if (userIdFromSession && userIdFromSession !== req.userId) {
      const userResult = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [
        req.userId,
      ]);
      const dbCustomerId = userResult.rows[0]?.stripe_customer_id;
      const sessionCustomerId =
        typeof session.customer === 'string' ? session.customer : session.customer?.id;
      if (!dbCustomerId || dbCustomerId !== sessionCustomerId) {
        return res.status(403).json({ error: 'Session does not belong to this user' });
      }
    }
    session.metadata = session.metadata || {};
    session.metadata.userId = req.userId.toString();
    await handleSubscriptionSuccess(session);
    const referenceNumbers = await getPaymentReferenceNumbers(req.userId);
    res.json({
      message: 'Subscription activated successfully',
      referenceNumbers: referenceNumbers || null,
    });
  } catch (error) {
    console.error('Verify session error:', error);
    const message = error.message || error.raw?.message || 'Failed to verify session';
    res.status(500).json({ error: message });
  }
});

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['stripe-signature'];
    const {
      verifyWebhookSignature,
      handleSubscriptionSuccess,
      handleSubscriptionCanceled,
      handleSubscriptionUpdated,
    } = await import('../services/stripe.js');
    const event = verifyWebhookSignature(req.body, signature);
    switch (event.type) {
      case 'checkout.session.completed':
        await handleSubscriptionSuccess(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionCanceled(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      default:
        break;
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).json({ error: 'Webhook processing failed' });
  }
});

router.post('/billing-portal', requireAuth, async (req, res) => {
  try {
    const { createBillingPortalSession } = await import('../services/stripe.js');
    const url = await createBillingPortalSession(req.userId);
    res.json({ url });
  } catch (error) {
    console.error('Billing portal error:', error);
    res.status(500).json({ error: error.message || 'Failed to open billing portal' });
  }
});

router.post('/cancel-subscription', requireAuth, async (req, res) => {
  try {
    const { cancelSubscription } = await import('../services/stripe.js');
    const result = await cancelSubscription(req.userId);
    if (result && result.refunded) {
      res.json({
        message:
          'Your subscription has been cancelled and your last payment has been refunded (within the 3-day period).',
        refunded: true,
      });
    } else {
      res.json({
        message:
          'Your subscription will be cancelled at the end of the current billing period. No refund was applied.',
        refunded: false,
      });
    }
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: error.message || 'Failed to cancel subscription' });
  }
});

router.get('/subscription-details', requireAuth, async (req, res) => {
  try {
    const { getSubscriptionDetails } = await import('../services/stripe.js');
    const subscription = await getSubscriptionDetails(req.userId);
    if (!subscription) {
      return res.status(404).json({ error: 'No active subscription found' });
    }
    res.json({ subscription });
  } catch (error) {
    console.error('Get subscription details error:', error);
    res.status(500).json({ error: 'Failed to get subscription details' });
  }
});

router.get('/verify-subscription', requireAuth, async (req, res) => {
  try {
    const { verifySubscriptionStatus } = await import('../services/stripe.js');
    const verification = await verifySubscriptionStatus(req.userId);
    res.json(verification);
  } catch (error) {
    console.error('Verify subscription error:', error);
    res.status(500).json({ error: 'Failed to verify subscription' });
  }
});

router.get('/reference-numbers', requireAuth, async (req, res) => {
  try {
    const { getPaymentReferenceNumbers } = await import('../services/stripe.js');
    const referenceNumbers = await getPaymentReferenceNumbers(req.userId);
    if (!referenceNumbers) {
      return res.status(404).json({ error: 'No payment information found' });
    }
    res.json({ referenceNumbers });
  } catch (error) {
    console.error('Get payment reference numbers error:', error);
    res.status(500).json({ error: 'Failed to get payment reference numbers' });
  }
});

router.get('/config', (req, res) => {
  res.json({
    publishableKey:
      (config.stripe && config.stripe.publishableKey) || process.env.STRIPE_PUBLISHABLE_KEY,
  });
});

export default router;
