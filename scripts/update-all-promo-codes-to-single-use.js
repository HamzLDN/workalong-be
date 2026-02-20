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
 * Update all promotion codes to allow only 1 redemption
 * Usage: node scripts/update-all-promo-codes-to-single-use.js [--dry-run]
 */
async function updateAllPromoCodesToSingleUse() {
  try {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');

    if (dryRun) {
      console.log('🔍 DRY RUN MODE - No changes will be made\n');
    }

    console.log('Fetching all promotion codes from Stripe...\n');

    let allPromoCodes = [];
    let hasMore = true;
    let startingAfter = null;

    // Fetch all promotion codes (Stripe paginates results)
    while (hasMore) {
      const params = {
        limit: 100
      };
      
      if (startingAfter) {
        params.starting_after = startingAfter;
      }

      const response = await stripe.promotionCodes.list(params);
      allPromoCodes = allPromoCodes.concat(response.data);
      
      hasMore = response.has_more;
      if (hasMore && response.data.length > 0) {
        startingAfter = response.data[response.data.length - 1].id;
      }
    }

    console.log(`Found ${allPromoCodes.length} total promotion codes\n`);

    // Filter to only active codes that don't have max_redemptions set to 1
    const codesToUpdate = allPromoCodes.filter(code => {
      // Skip if already has max_redemptions: 1
      if (code.max_redemptions === 1) {
        return false;
      }
      // Only update active codes
      return code.active === true;
    });

    console.log(`Found ${codesToUpdate.length} promotion codes that need updating\n`);

    if (codesToUpdate.length === 0) {
      console.log('✅ All promotion codes already have max_redemptions: 1');
      return;
    }

    if (dryRun) {
      console.log('Codes that would be updated:');
      codesToUpdate.forEach((code, index) => {
        console.log(`${index + 1}. ${code.code} (ID: ${code.id})`);
        console.log(`   Current max_redemptions: ${code.max_redemptions || 'unlimited'}`);
        console.log(`   Times redeemed: ${code.times_redeemed || 0}`);
      });
      console.log('\nRun without --dry-run to apply changes');
      return;
    }

    // Update each code
    const results = {
      success: [],
      failed: []
    };

    for (const promoCode of codesToUpdate) {
      try {
        console.log(`\nProcessing: ${promoCode.code}...`);
        console.log(`  Current max_redemptions: ${promoCode.max_redemptions || 'unlimited'}`);
        console.log(`  Times redeemed: ${promoCode.times_redeemed || 0}`);

        // Get the coupon ID
        const couponId = typeof promoCode.coupon === 'string' ? promoCode.coupon : promoCode.coupon?.id;
        
        if (!couponId) {
          console.log(`  ⚠️  Skipping: No coupon found`);
          results.failed.push({ code: promoCode.code, reason: 'No coupon found' });
          continue;
        }

        // Deactivate the old promotion code
        await stripe.promotionCodes.update(promoCode.id, {
          active: false
        });
        console.log(`  ✅ Deactivated old code`);

        // Create a new promotion code with max_redemptions: 1
        const newPromoCode = await stripe.promotionCodes.create({
          coupon: couponId,
          code: promoCode.code,
          active: true,
          max_redemptions: 1,
          metadata: promoCode.metadata || {}
        });

        console.log(`  ✅ Created new code with max_redemptions: 1`);
        console.log(`  New Promotion Code ID: ${newPromoCode.id}`);
        
        results.success.push({
          oldId: promoCode.id,
          newId: newPromoCode.id,
          code: promoCode.code,
          timesRedeemed: promoCode.times_redeemed || 0
        });

      } catch (error) {
        console.error(`  ❌ Error updating ${promoCode.code}:`, error.message);
        results.failed.push({
          code: promoCode.code,
          reason: error.message
        });
      }
    }

    // Summary
    console.log('\n========================================');
    console.log('SUMMARY');
    console.log('========================================');
    console.log(`✅ Successfully updated: ${results.success.length}`);
    console.log(`❌ Failed: ${results.failed.length}`);
    
    if (results.success.length > 0) {
      console.log('\nSuccessfully updated codes:');
      results.success.forEach((result, index) => {
        console.log(`${index + 1}. ${result.code}`);
        console.log(`   Old ID: ${result.oldId}`);
        console.log(`   New ID: ${result.newId}`);
        console.log(`   Previous redemptions: ${result.timesRedeemed}`);
      });
    }

    if (results.failed.length > 0) {
      console.log('\nFailed codes:');
      results.failed.forEach((result, index) => {
        console.log(`${index + 1}. ${result.code}: ${result.reason}`);
      });
    }

    console.log('\n========================================');
    console.log(`Total processed: ${codesToUpdate.length}`);
    console.log('========================================\n');

  } catch (error) {
    console.error('❌ Error updating promotion codes:', error.message);
    if (error.type === 'StripeAuthenticationError') {
      console.error('\n💡 Check your Stripe secret key in .env file');
    }
    process.exit(1);
  }
}

updateAllPromoCodesToSingleUse();


