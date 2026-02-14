import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function checkUser(email) {
  try {
    const result = await pool.query(
      `SELECT 
        id, 
        email, 
        name, 
        subscription_status, 
        subscription_plan,
        stripe_customer_id,
        stripe_subscription_id,
        created_at
      FROM users 
      WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      console.log('No user found with email:', email);
      await pool.end();
      return;
    }

    const user = result.rows[0];
    console.log('\nUser found in database:\n');
    console.log('   ID:', user.id);
    console.log('   Email:', user.email);
    console.log('   Name:', user.name);
    console.log('   Subscription Status:', user.subscription_status || 'free/none');
    console.log('   Subscription Plan:', user.subscription_plan || 'N/A');
    console.log('   Stripe Customer ID:', user.stripe_customer_id || 'Not set');
    console.log('   Stripe Subscription ID:', user.stripe_subscription_id || 'Not set');
    console.log('   Account Created:', user.created_at);
    console.log('');

    if (user.stripe_customer_id) {
      console.log('To check in Stripe Dashboard:');
      console.log('   1. Go to https://dashboard.stripe.com/customers/' + user.stripe_customer_id);
      console.log('   2. Or search for:', user.email);
    } else {
      console.log('No Stripe customer ID found - user has not subscribed yet');
    }

    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    await pool.end();
  }
}

checkUser('hamchenhbf3@gmail.com');
