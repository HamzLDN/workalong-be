import Stripe from 'stripe';
import { config } from '../lib/config.js';
import dotenv from 'dotenv';

dotenv.config();

const stripeSecretKey = config.stripe?.secretKey || process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey || !String(stripeSecretKey).startsWith('sk_')) {
  console.error('ERROR: Stripe secret key missing or invalid');
  process.exit(1);
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2024-11-20.acacia'
});

/**
 * Create a 100% free promo code that requires credit card but charges £0.00
 * Usage: node scripts/create-free-promo-code.js [CUSTOM_CODE_NAME]
 */
async function createFreePromoCode() {
  try {
    const customCode = process.argv[2] || `FREE100_${Date.now().toString(36).toUpperCase()}`;
    
    console.log('Creating 100% free promo code...');
    console.log(`Custom code: ${customCode}`);
    
    // Create a coupon with 100% discount, applies to first invoice only
    const coupon = await stripe.coupons.create({
      percent_off: 100,
      duration: 'forever', // Free forever, not just first month
      name: `100% Free - ${customCode}`,
      metadata: {
        created_by: 'admin',
        purpose: 'custom_free_client',
        code: customCode
      }
    });
    
    console.log(`✅ Coupon created: ${coupon.id}`);
    
    // Create a promotion code linked to the coupon
    const promotionCode = await stripe.promotionCodes.create({
      coupon: coupon.id,
      code: customCode,
      active: true,
      metadata: {
        created_by: 'admin',
        purpose: 'custom_free_client'
      }
    });
    
    console.log('\n✅ Promotion code created successfully!');
    console.log('========================================');
    console.log(`Promo Code: ${promotionCode.code}`);
    console.log(`Coupon ID: ${coupon.id}`);
    console.log(`Promotion Code ID: ${promotionCode.id}`);
    console.log(`Discount: 100% off (FREE)`);
    console.log(`Duration: Forever`);
    console.log('========================================');
    console.log('\n📋 Instructions:');
    console.log(`1. Share this code with your client: ${promotionCode.code}`);
    console.log('2. Client must enter credit card (for verification)');
    console.log('3. They will be charged £0.00');
    console.log('4. They get full access forever');
    console.log('\n⚠️  Note: This code can be used multiple times unless you limit it in Stripe dashboard');
    
    return { coupon, promotionCode };
  } catch (error) {
    console.error('❌ Error creating promo code:', error.message);
    if (error.code === 'resource_already_exists') {
      console.error('\n💡 This promo code already exists. Try a different code name.');
    }
    process.exit(1);
  }
}

createFreePromoCode();

