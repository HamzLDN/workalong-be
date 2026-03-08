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
 * Remove all promotion codes (deactivate them)
 * Usage: node scripts/remove-all-promo-codes.js [--dry-run] [--delete]
 *
 * By default, codes are deactivated (can be reactivated later)
 * Use --delete to permanently delete them (cannot be undone)
 */
async function removeAllPromoCodes() {
  try {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const deletePermanently = args.includes('--delete');

    if (dryRun) {
      console.log('🔍 DRY RUN MODE - No changes will be made\n');
    }

    if (deletePermanently) {
      console.log('⚠️  DELETE MODE - Codes will be permanently deleted (cannot be undone)\n');
    } else {
      console.log('ℹ️  Codes will be deactivated (can be reactivated later)\n');
      console.log('   Use --delete to permanently delete them\n');
    }

    console.log('Fetching all promotion codes from Stripe...\n');

    let allPromoCodes = [];
    let hasMore = true;
    let startingAfter = null;

    // Fetch all promotion codes (Stripe paginates results)
    while (hasMore) {
      const params = {
        limit: 100,
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

    // Filter to only active codes
    const activeCodes = allPromoCodes.filter((code) => code.active === true);

    console.log(`Found ${activeCodes.length} active promotion codes\n`);

    if (activeCodes.length === 0) {
      console.log('✅ No active promotion codes to remove');
      return;
    }

    if (dryRun) {
      console.log('Codes that would be removed:');
      activeCodes.forEach((code, index) => {
        console.log(`${index + 1}. ${code.code} (ID: ${code.id})`);
        console.log(`   Times redeemed: ${code.times_redeemed || 0}`);
        console.log(`   Max redemptions: ${code.max_redemptions || 'unlimited'}`);
      });
      console.log(
        `\nRun without --dry-run to ${deletePermanently ? 'delete' : 'deactivate'} these codes`
      );
      return;
    }

    // Remove each code
    const results = {
      success: [],
      failed: [],
    };

    for (const promoCode of activeCodes) {
      try {
        console.log(`\nProcessing: ${promoCode.code}...`);
        console.log(`  Times redeemed: ${promoCode.times_redeemed || 0}`);

        if (deletePermanently) {
          // Note: Stripe doesn't allow deleting promotion codes directly
          // We can only deactivate them
          console.log(
            `  ⚠️  Note: Stripe doesn't allow deleting promotion codes. Deactivating instead.`
          );
        }

        // Deactivate the promotion code
        await stripe.promotionCodes.update(promoCode.id, {
          active: false,
        });

        console.log(`  ✅ ${deletePermanently ? 'Deactivated' : 'Deactivated'} code`);

        results.success.push({
          id: promoCode.id,
          code: promoCode.code,
          timesRedeemed: promoCode.times_redeemed || 0,
        });
      } catch (error) {
        console.error(`  ❌ Error removing ${promoCode.code}:`, error.message);
        results.failed.push({
          code: promoCode.code,
          reason: error.message,
        });
      }
    }

    // Summary
    console.log('\n========================================');
    console.log('SUMMARY');
    console.log('========================================');
    console.log(
      `✅ Successfully ${deletePermanently ? 'deleted' : 'deactivated'}: ${results.success.length}`
    );
    console.log(`❌ Failed: ${results.failed.length}`);

    if (results.success.length > 0) {
      console.log(`\nSuccessfully ${deletePermanently ? 'deleted' : 'deactivated'} codes:`);
      results.success.forEach((result, index) => {
        console.log(`${index + 1}. ${result.code} (ID: ${result.id})`);
        console.log(`   Times redeemed: ${result.timesRedeemed}`);
      });
    }

    if (results.failed.length > 0) {
      console.log('\nFailed codes:');
      results.failed.forEach((result, index) => {
        console.log(`${index + 1}. ${result.code}: ${result.reason}`);
      });
    }

    console.log('\n========================================');
    console.log(`Total processed: ${activeCodes.length}`);
    console.log('========================================\n');

    if (!deletePermanently) {
      console.log('ℹ️  Note: Codes have been deactivated, not deleted.');
      console.log('   They can be reactivated in the Stripe dashboard if needed.');
      console.log('   Stripe does not allow permanent deletion of promotion codes.\n');
    }
  } catch (error) {
    console.error('❌ Error removing promotion codes:', error.message);
    if (error.type === 'StripeAuthenticationError') {
      console.error('\n💡 Check your Stripe secret key in .env file');
    }
    process.exit(1);
  }
}

removeAllPromoCodes();
