import Stripe from 'stripe';
import { config } from '@/config';

export const stripe = config.stripe.secretKey
  ? new Stripe(config.stripe.secretKey, { apiVersion: '2026-04-22.dahlia' })
  : null;
