#!/usr/bin/env node
/**
 * Test script for payment reference numbers endpoint
 * 
 * Usage:
 *   node test-payment-references.js <email> <password>
 * 
 * Or set environment variables:
 *   EMAIL=user@example.com PASSWORD=password123 node test-payment-references.js
 */

const API_URL = process.env.API_URL || 'http://localhost:8080/api';

async function testPaymentReferences() {
  const email = process.argv[2] || process.env.EMAIL;
  const password = process.argv[3] || process.env.PASSWORD;

  if (!email || !password) {
    console.error('Usage: node test-payment-references.js <email> <password>');
    console.error('   Or set EMAIL and PASSWORD environment variables');
    process.exit(1);
  }

  try {
    console.log('Signing in...');
    // Sign in to get session cookie
    const signInResponse = await fetch(`${API_URL}/auth/signin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
      credentials: 'include'
    });

    if (!signInResponse.ok) {
      const error = await signInResponse.json();
      throw new Error(`Sign in failed: ${error.error || signInResponse.statusText}`);
    }

    // Get cookies from response
    const cookies = signInResponse.headers.get('set-cookie');
    if (!cookies) {
      throw new Error('No session cookie received');
    }

    console.log('Signed in successfully\n');

    // Extract session cookie
    const sessionCookie = cookies.split(';')[0];

    console.log('Fetching payment reference numbers...\n');
    
    // Call the reference numbers endpoint
    const refResponse = await fetch(`${API_URL}/payment/reference-numbers`, {
      method: 'GET',
      headers: {
        'Cookie': sessionCookie,
      },
    });

    if (!refResponse.ok) {
      const error = await refResponse.json();
      throw new Error(`Failed to get reference numbers: ${error.error || refResponse.statusText}`);
    }

    const data = await refResponse.json();
    const refs = data.referenceNumbers;

    if (!refs) {
      console.log('No payment information found for this user.');
      console.log('   This user may not have an active subscription.');
      return;
    }

    console.log('Payment Reference Numbers:\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Customer ID:        ${refs.customerId || 'N/A'}`);
    console.log(`Subscription ID:    ${refs.subscriptionId || 'N/A'}`);
    console.log(`Invoice ID:         ${refs.invoiceId || 'N/A'}`);
    console.log(`Invoice Number:     ${refs.invoiceNumber || 'N/A'}`);
    console.log(`Payment Intent ID:  ${refs.paymentIntentId || 'N/A'}`);
    console.log(`Checkout Session:   ${refs.checkoutSessionId || 'N/A'}`);
    console.log(`Plan:               ${refs.plan || 'N/A'}`);
    console.log(`Subscription End:    ${refs.subscriptionCurrentPeriodEnd ? new Date(refs.subscriptionCurrentPeriodEnd).toLocaleString() : 'N/A'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`\nPrimary Reference (for proof of purchase):`);
    console.log(`   ${refs.primaryReference || 'N/A'}\n`);

    if (refs.allInvoices && refs.allInvoices.length > 0) {
      console.log(`Payment History (${refs.allInvoices.length} invoice(s)):\n`);
      refs.allInvoices.forEach((invoice, index) => {
        console.log(`   ${index + 1}. Invoice ${invoice.number || invoice.id}`);
        console.log(`      Amount: ${invoice.currency?.toUpperCase()} ${invoice.amountPaid}`);
        console.log(`      Status: ${invoice.status}`);
        console.log(`      Date: ${invoice.created.toLocaleString()}`);
        if (invoice.paidAt) {
          console.log(`      Paid: ${invoice.paidAt.toLocaleString()}`);
        }
        console.log('');
      });
    }

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

testPaymentReferences();

