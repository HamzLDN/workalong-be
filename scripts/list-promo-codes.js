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
 * List all promotion codes, especially custom free client codes
 * Usage: node scripts/list-promo-codes.js [--all] [--active-only] [--custom-only]
 */
async function listPromoCodes() {
  try {
    const args = process.argv.slice(2);
    const showAll = args.includes('--all');
    const activeOnly = args.includes('--active-only');
    const customOnly = args.includes('--custom-only') || (!showAll && !activeOnly); // Default to custom only

    console.log('Fetching promotion codes from Stripe...\n');

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

    // Filter codes based on options
    let filteredCodes = allPromoCodes;

    if (customOnly) {
      // Filter for codes created by admin for custom free clients
      filteredCodes = allPromoCodes.filter(code => 
        code.metadata?.created_by === 'admin' || 
        code.metadata?.purpose === 'custom_free_client' ||
        code.coupon?.metadata?.purpose === 'custom_free_client'
      );
      console.log(`Filtered to ${filteredCodes.length} custom free client codes\n`);
    }

    if (activeOnly) {
      filteredCodes = filteredCodes.filter(code => code.active);
      console.log(`Filtered to ${filteredCodes.length} active codes\n`);
    }

    if (filteredCodes.length === 0) {
      console.log('No promotion codes found matching the criteria.');
      return;
    }

    // Fetch full coupon details for each code
    const codesWithCoupons = await Promise.all(
      filteredCodes.map(async (promoCode) => {
        try {
          const coupon = await stripe.coupons.retrieve(promoCode.coupon.id);
          return { promoCode, coupon };
        } catch (error) {
          console.warn(`Warning: Could not fetch coupon ${promoCode.coupon.id}: ${error.message}`);
          return { promoCode, coupon: null };
        }
      })
    );

    // Display results
    console.log('========================================');
    console.log('PROMOTION CODES');
    console.log('========================================\n');

    codesWithCoupons.forEach(({ promoCode, coupon }, index) => {
      console.log(`${index + 1}. ${promoCode.code}`);
      console.log(`   Status: ${promoCode.active ? '✅ Active' : '❌ Inactive'}`);
      console.log(`   Promotion Code ID: ${promoCode.id}`);
      
      if (coupon) {
        console.log(`   Coupon ID: ${coupon.id}`);
        console.log(`   Discount: ${coupon.percent_off ? `${coupon.percent_off}% off` : coupon.amount_off ? `£${(coupon.amount_off / 100).toFixed(2)} off` : 'N/A'}`);
        console.log(`   Duration: ${coupon.duration}`);
        console.log(`   Name: ${coupon.name || 'N/A'}`);
        
        if (coupon.metadata && Object.keys(coupon.metadata).length > 0) {
          console.log(`   Metadata:`, coupon.metadata);
        }
      }
      
      if (promoCode.metadata && Object.keys(promoCode.metadata).length > 0) {
        console.log(`   Promo Metadata:`, promoCode.metadata);
      }

      // Show usage limits if set
      if (promoCode.max_redemptions) {
        console.log(`   Max Redemptions: ${promoCode.max_redemptions}`);
        console.log(`   Times Redeemed: ${promoCode.times_redeemed || 0}`);
      } else {
        console.log(`   Times Redeemed: ${promoCode.times_redeemed || 0} (unlimited)`);
      }

      // Show expiration if set
      if (promoCode.expires_at) {
        const expiryDate = new Date(promoCode.expires_at * 1000);
        console.log(`   Expires: ${expiryDate.toLocaleString()}`);
      }

      console.log('');
    });

    console.log('========================================');
    console.log(`Total: ${codesWithCoupons.length} promotion code(s)`);
    console.log('========================================\n');

    console.log('Usage options:');
    console.log('  --all          Show all promotion codes (not just custom ones)');
    console.log('  --active-only   Show only active codes');
    console.log('  --custom-only   Show only custom free client codes (default)');

  } catch (error) {
    console.error('❌ Error listing promo codes:', error.message);
    if (error.type === 'StripeAuthenticationError') {
      console.error('\n💡 Check your Stripe secret key in .env file');
    }
    process.exit(1);
  }
}

listPromoCodes();


