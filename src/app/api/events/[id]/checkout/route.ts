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
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!stripe) {
    return NextResponse.json({ error: 'Payment not configured' }, { status: 503 });
  }

  const { id: eventId } = await params;

  const event = await db.event.findUnique({
    where: { id: eventId },
    include: { package: true, organizer: { select: { id: true, email: true } } },
  });

  if (!event) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (event.organizerId !== session.user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (event.status === 'ACTIVE' || event.paymentStatus === 'PAID') {
    return NextResponse.json({ error: 'Already paid' }, { status: 409 });
  }
  if (!event.package?.stripePriceId) {
    return NextResponse.json({ error: 'Package not configured' }, { status: 422 });
  }

  const appUrl = config.app.publicUrl;
  const successUrl = `${appUrl}/events/${eventId}/pay/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${appUrl}/events/${eventId}/pay/cancel`;

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
        actorId: session.user.id,
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
