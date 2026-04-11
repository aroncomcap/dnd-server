const Stripe = require('stripe');
const db = require('./db');

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// Product definitions
const PRODUCTS = {
  'playtime_1hr':  { minutes: 60,   priceInCents: 100,  name: '1 Hour of Playtime' },
  'playtime_5hr':  { minutes: 300,  priceInCents: 450,  name: '5 Hours of Playtime' },
  'playtime_20hr': { minutes: 1200, priceInCents: 1500, name: '20 Hours of Playtime' },
};

async function createCheckoutSession(userId, productId, returnUrl) {
  if (!stripe) throw new Error('Stripe not configured');
  const product = PRODUCTS[productId];
  if (!product) throw new Error('Invalid product');

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: product.name },
        unit_amount: product.priceInCents,
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: `${returnUrl}/purchase?success=true`,
    cancel_url: `${returnUrl}/purchase?canceled=true`,
    metadata: { userId, productId },
  });

  return session;
}

async function handleWebhook(payload, sig) {
  if (!stripe) throw new Error('Stripe not configured');
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!endpointSecret) {
    throw new Error('Stripe webhook secret not configured — refusing to process unverified webhook');
  }
  let event;
  event = stripe.webhooks.constructEvent(payload, sig, endpointSecret);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { userId, productId } = session.metadata;
    const product = PRODUCTS[productId];

    if (userId && product) {
      await db.creditMinutes(userId, product.minutes, {
        provider: 'stripe',
        providerTxId: session.payment_intent || session.id,
        productId,
        amountCents: product.priceInCents,
        creditType: 'purchase',
        expiresAt: null, // purchased minutes never expire
      });
      console.log(`Payment: credited ${product.minutes} min to user ${userId} for ${productId}`);
    }
  }

  return { received: true };
}

function isConfigured() {
  return !!stripe;
}

module.exports = { createCheckoutSession, handleWebhook, PRODUCTS, isConfigured };
