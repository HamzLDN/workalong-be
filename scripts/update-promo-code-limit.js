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
  apiVersion: '2024-11-20.acacia',
});

/**
 * Update a promotion code to limit redemptions
 * Usage: node scripts/update-promo-code-limit.js <PROMO_CODE> <MAX_REDEMPTIONS>
 * Example: node scripts/update-promo-code-limit.js TEST_CODE 1
 */
async function updatePromoCodeLimit() {
  try {
    const args = process.argv.slice(2);

    if (args.length < 2) {
      console.error(
        'Usage: node scripts/update-promo-code-limit.js <PROMO_CODE> <MAX_REDEMPTIONS>'
      );
      console.error('Example: node scripts/update-promo-code-limit.js TEST_CODE 1');
      process.exit(1);
    }

    const promoCodeString = args[0];
    const maxRedemptions = parseInt(args[1], 10);

    if (isNaN(maxRedemptions) || maxRedemptions < 1) {
      console.error('ERROR: max_redemptions must be a positive number');
      process.exit(1);
    }

    console.log(`Looking up promotion code: ${promoCodeString}...\n`);

    // Find the promotion code by code string
    const promoList = await stripe.promotionCodes.list({
      code: promoCodeString,
      limit: 1,
    });

    if (!promoList.data || promoList.data.length === 0) {
      console.error(`❌ Promotion code "${promoCodeString}" not found`);
      process.exit(1);
    }

    const promoCode = promoList.data[0];
    console.log(`Found promotion code: ${promoCode.code}`);
    console.log(`Current max_redemptions: ${promoCode.max_redemptions || 'unlimited'}`);
    console.log(`Current times_redeemed: ${promoCode.times_redeemed || 0}\n`);

    // Warn if it's already been redeemed more than the limit
    if (promoCode.times_redeemed && promoCode.times_redeemed > maxRedemptions) {
      console.error(
        `❌ This code has already been redeemed ${promoCode.times_redeemed} time(s), which is > ${maxRedemptions}`
      );
      console.error('   You cannot set a limit lower than the current redemption count.');
      process.exit(1);
    }

    // Warn if it's already been redeemed the max amount
    if (promoCode.times_redeemed && promoCode.times_redeemed === maxRedemptions) {
      console.log(
        `⚠️  Warning: This code has already been redeemed ${promoCode.times_redeemed} time(s).`
      );
      console.log(
        `   Setting max_redemptions to ${maxRedemptions} will prevent any future redemptions.\n`
      );
    }

    // Update the promotion code
    // Note: Stripe doesn't allow updating max_redemptions after creation
    // We need to deactivate the old one and create a new one with the limit
    console.log(`Setting max_redemptions to ${maxRedemptions}...`);
    console.log(
      `Note: Stripe doesn't allow updating max_redemptions. We'll deactivate the old code and create a new one.\n`
    );

    // Deactivate the old promotion code
    await stripe.promotionCodes.update(promoCode.id, {
      active: false,
    });
    console.log(`✅ Deactivated old promotion code: ${promoCode.code}`);

    // Get the coupon ID
    const couponId = typeof promoCode.coupon === 'string' ? promoCode.coupon : promoCode.coupon?.id;

    // Create a new promotion code with the same code and coupon, but with max_redemptions
    const updated = await stripe.promotionCodes.create({
      coupon: couponId,
      code: promoCode.code,
      active: true,
      max_redemptions: maxRedemptions,
      metadata: promoCode.metadata || {},
    });

    console.log(`✅ Created new promotion code with max_redemptions: ${maxRedemptions}`);

    console.log('\n✅ Promotion code updated successfully!');
    console.log(`   Code: ${updated.code}`);
    console.log(`   Max Redemptions: ${updated.max_redemptions}`);
    console.log(`   Times Redeemed: ${updated.times_redeemed || 0}`);
    console.log(`   Remaining: ${updated.max_redemptions - (updated.times_redeemed || 0)}`);
  } catch (error) {
    console.error('❌ Error updating promotion code:', error.message);
    if (error.type === 'StripeInvalidRequestError') {
      console.error(`   Stripe error: ${error.raw?.message || error.message}`);
    }
    process.exit(1);
  }
}

updatePromoCodeLimit();
