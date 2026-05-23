import Stripe from 'stripe';
import { config } from '@/config';

if (!config.stripe.secretKey) {
  if (config.env === 'production') throw new Error('STRIPE_SECRET_KEY is required');
}

export const stripe = config.stripe.secretKey
  ? new Stripe(config.stripe.secretKey, { apiVersion: '2026-04-22.dahlia' })
  : null;
