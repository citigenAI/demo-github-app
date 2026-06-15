import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { stripe } from '@/lib/stripe';
import { config } from '@/config';
import { logger } from '@/lib/logger';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: eventId } = await params;

  const event = await db.event.findUnique({
    where: { id: eventId },
    include: { package: true, organizer: { select: { id: true, email: true } } },
  });

  if (!event) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (event.organizerId !== userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (event.status === 'ACTIVE' || event.paymentStatus === 'PAID') {
    return NextResponse.json({ error: 'Already paid' }, { status: 409 });
  }

  const appUrl = config.app.publicUrl;
  const successUrl = `${appUrl}/events/${eventId}/pay/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${appUrl}/events/${eventId}/pay/cancel`;

  // Mock-payment fallback: when Stripe isn't configured (no secret key OR
  // package has no stripePriceId), immediately activate the event using the
  // same atomic write the webhook does. Production with keys configured uses
  // the real Stripe flow below.
  if (!stripe || !event.package?.stripePriceId) {
    await db.$transaction(async (tx) => {
      await tx.event.update({
        where: { id: eventId },
        data: { status: 'ACTIVE', paymentStatus: 'PAID' },
      });
      await tx.auditLog.create({
        data: {
          eventId,
          actorId: userId,
          action: 'payment.mock_activated',
          metadata: { reason: !stripe ? 'stripe_not_configured' : 'package_missing_price_id' },
        },
      });
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

    logger.info({ eventId, mode: 'mock' }, 'Event activated via mock payment');
    return NextResponse.json({ url: `${appUrl}/events/${eventId}/pay/success?mock=1` });
  }

  try {
    const checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [{ price: event.package.stripePriceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: eventId,
        metadata: { eventId, packageId: event.packageId, organizerId: event.organizerId },
      },
      { idempotencyKey: `checkout:${eventId}` },
    );

    await db.event.update({
      where: { id: eventId },
      data: { stripeSessionId: checkoutSession.id, paymentStatus: 'PENDING' },
    });

    await db.auditLog.create({
      data: {
        eventId,
        actorId: userId,
        action: 'payment.checkout_created',
        metadata: { sessionId: checkoutSession.id },
      },
    });

    logger.info({ eventId, sessionId: checkoutSession.id }, 'Checkout session created');
    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    logger.error({ err, eventId }, 'Stripe checkout session creation failed');
    return NextResponse.json({ error: 'Payment service error' }, { status: 500 });
  }
}
