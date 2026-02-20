import { pool } from '../lib/db.js';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { config } from '../lib/config.js';

dotenv.config();

const stripeSecretKey = config.stripe?.secretKey || process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecretKey && String(stripeSecretKey).startsWith('sk_') 
  ? new Stripe(stripeSecretKey) 
  : null;

/**
 * Grant free access to a user with a custom key
 * Usage: node scripts/grant-free-access.js [USER_EMAIL] [CUSTOM_KEY]
 * 
 * This creates a Stripe subscription with £0.00 charge that requires credit card
 */
async function grantFreeAccess() {
  try {
    const userEmail = process.argv[2];
    const customKey = process.argv[3] || `FREE_${Date.now().toString(36).toUpperCase()}`;
    
    if (!userEmail) {
      console.error('❌ Usage: node scripts/grant-free-access.js [USER_EMAIL] [CUSTOM_KEY]');
      console.error('Example: node scripts/grant-free-access.js client@example.com CLIENT2024');
      process.exit(1);
    }
    
    console.log(`Granting free access to: ${userEmail}`);
    console.log(`Custom key: ${customKey}`);
    
    // Find user by email
    const userResult = await pool.query(
      'SELECT id, email, name, stripe_customer_id FROM users WHERE email = $1',
      [userEmail]
    );
    
    if (userResult.rows.length === 0) {
      console.error(`❌ User not found: ${userEmail}`);
      console.error('💡 User must sign up first before granting free access');
      process.exit(1);
    }
    
    const user = userResult.rows[0];
    console.log(`✅ Found user: ${user.name || user.email} (ID: ${user.id})`);
    
    if (!stripe) {
      console.error('❌ Stripe not configured. Cannot create subscription.');
      process.exit(1);
    }
    
    // Get or create Stripe customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      console.log('Creating Stripe customer...');
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { 
          userId: user.id.toString(),
          customKey: customKey,
          freeAccess: 'true'
        }
      });
      customerId = customer.id;
      await pool.query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, user.id]
      );
      console.log(`✅ Created Stripe customer: ${customerId}`);
    } else {
      // Update customer metadata
      await stripe.customers.update(customerId, {
        metadata: {
          userId: user.id.toString(),
          customKey: customKey,
          freeAccess: 'true'
        }
      });
      console.log(`✅ Updated Stripe customer metadata`);
    }
    
    // Cancel any existing subscription
    const existingSubs = await stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1
    });
    
    if (existingSubs.data.length > 0) {
      console.log('Cancelling existing subscription...');
      await stripe.subscriptions.cancel(existingSubs.data[0].id);
      console.log('✅ Cancelled existing subscription');
    }
    
    // Create a £0.00 price (one-time or subscription)
    // For subscription, we'll create a £0.00/month price
    console.log('Creating £0.00 subscription...');
    
    // Create a product for free access
    const product = await stripe.products.create({
      name: 'WorkAlong Free Access',
      description: `Free access granted with key: ${customKey}`,
      metadata: {
        customKey: customKey,
        freeAccess: 'true',
        userId: user.id.toString()
      }
    });
    
    // Create a £0.00 price
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: 0, // £0.00
      currency: 'gbp',
      recurring: {
        interval: 'month'
      },
      metadata: {
        customKey: customKey,
        freeAccess: 'true'
      }
    });
    
    console.log(`✅ Created product and price: ${price.id}`);
    
    // Create subscription with £0.00
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: price.id }],
      metadata: {
        userId: user.id.toString(),
        customKey: customKey,
        freeAccess: 'true',
        grantedBy: 'admin_script'
      },
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription'
      },
      expand: ['latest_invoice.payment_intent']
    });
    
    console.log(`✅ Created subscription: ${subscription.id}`);
    
    // Update user in database
    await pool.query(
      `UPDATE users 
       SET subscription_status = 'paid',
           subscription_plan = 'professional',
           subscription_staff_limit = NULL
       WHERE id = $1`,
      [user.id]
    );
    
    console.log('\n✅ Free access granted successfully!');
    console.log('========================================');
    console.log(`User: ${user.email}`);
    console.log(`Custom Key: ${customKey}`);
    console.log(`Subscription ID: ${subscription.id}`);
    console.log(`Price: £0.00/month`);
    console.log('========================================');
    console.log('\n📋 Next Steps:');
    console.log(`1. User needs to complete payment setup at: ${subscription.latest_invoice?.hosted_invoice_url || 'N/A'}`);
    console.log('2. They will be charged £0.00 (credit card required for verification)');
    console.log('3. They will have full access once payment method is added');
    console.log(`\n💡 Share this subscription ID with support if needed: ${subscription.id}`);
    
  } catch (error) {
    console.error('❌ Error granting free access:', error.message);
    if (error.raw) {
      console.error('Stripe error:', error.raw);
    }
    process.exit(1);
  }
}

grantFreeAccess();

