import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { stripe } from '@/lib/stripe';
import { config } from '@/config';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

// Next.js App Router: read raw body by not using the parsed stream
export const runtime = 'nodejs';

async function activateEvent(session: Stripe.Checkout.Session) {
  const eventId = session.client_reference_id ?? (session.metadata?.eventId as string | undefined);
  if (!eventId) {
    logger.warn({ sessionId: session.id }, 'Webhook: no eventId in session — skipping');
    return;
  }

  // Verify the session matches the stored session id
  const event = await db.event.findFirst({
    where: { id: eventId },
    include: { organizer: { select: { email: true } } },
  });

  if (!event) {
    logger.warn({ eventId, sessionId: session.id }, 'Webhook: event not found for session');
    return;
  }

  // Idempotency: already activated
  if (event.status === 'ACTIVE' && event.paymentStatus === 'PAID') {
    logger.info({ eventId }, 'Webhook: already activated — no-op');
    return;
  }

  await db.$transaction(async (tx) => {
    await tx.event.update({
      where: { id: eventId },
      data: { status: 'ACTIVE', paymentStatus: 'PAID', stripeSessionId: session.id },
    });

    await tx.auditLog.create({
      data: {
        eventId,
        actorId: null,
        action: 'payment.activated',
        metadata: {
          stripeSessionId: session.id,
          packageId: event.packageId,
          amountTotal: session.amount_total,
          currency: session.currency,
        },
      },
    });

    // Check for existing notification to guard against duplicate enqueue
    const existingNotif = await tx.notificationLog.findFirst({
      where: { eventId, trigger: 'event.activated' },
    });
    if (!existingNotif) {
      await tx.notificationLog.create({
        data: {
          eventId,
          recipientType: 'organizer',
          recipientEmail: event.organizer.email,
          channel: 'email',
          trigger: 'event.activated',
          status: 'queued',
        },
      });
    }
  });

  logger.info({ eventId, sessionId: session.id }, 'Event activated via webhook');
}

export async function POST(req: NextRequest) {
  if (!stripe || !config.stripe.webhookSecret) {
    logger.error('Webhook received but Stripe not configured');
    return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  }

  const rawBody = await req.text();
  const sig = req.headers.get('stripe-signature');

  if (!sig) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, config.stripe.webhookSecret);
  } catch (err) {
    logger.warn({ err }, 'Invalid Stripe webhook signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await activateEvent(event.data.object as Stripe.Checkout.Session);
        break;

      case 'checkout.session.async_payment_failed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const eventId = session.client_reference_id ?? session.metadata?.eventId;
        if (eventId) {
          // Only downgrade if not already paid
          await db.event.updateMany({
            where: { id: eventId, paymentStatus: { not: 'PAID' } },
            data: { paymentStatus: 'FAILED' },
          });
          await db.auditLog.create({
            data: { eventId, action: 'payment.failed', metadata: { sessionId: session.id } },
          });
        }
        break;
      }

      case 'checkout.session.expired': {
        const session = event.data.object as Stripe.Checkout.Session;
        const eventId = session.client_reference_id ?? session.metadata?.eventId;
        if (eventId) {
          await db.event.updateMany({
            where: { id: eventId, stripeSessionId: session.id, paymentStatus: 'PENDING' },
            data: { paymentStatus: 'FAILED' },
          });
        }
        break;
      }

      default:
        logger.debug({ type: event.type }, 'Unhandled Stripe event type — acknowledged');
    }
  } catch (err) {
    logger.error({ err, eventType: event.type }, 'Webhook handler error');
    return NextResponse.json({ error: 'Handler error' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
