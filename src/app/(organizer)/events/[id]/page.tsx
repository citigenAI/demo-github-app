import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getEvent } from '../actions';
import { buildContributorUrl, buildWhatsAppShare, buildEmailShare, occasionNouns } from '@/lib/share';
import { generateContributorQr } from '@/lib/qr';
import { CopyButton } from './CopyButton';
import { PayButton } from './PayButton';
import { Link as LinkIcon, QrCode, Share2, Mail, CalendarDays, Users, Package } from 'lucide-react';

const occasionLabels: Record<string, string> = {
  GRADUATION: 'Graduation',
  BIRTHDAY: 'Birthday',
  WEDDING: 'Wedding',
  ANNIVERSARY: 'Anniversary',
  RETIREMENT: 'Retirement',
  BUSINESS_EVENT: 'Business Event',
};

function formatDate(date: Date) {
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function SectionCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border border-brand-stone/10 rounded-xl p-5 bg-white">
      <div className="flex items-center gap-2 mb-4 text-brand-ink">
        {icon}
        <h2 className="font-display text-base font-semibold">{title}</h2>
      </div>
      {children}
    </div>
  );
}

export default async function EventDetailPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const { id } = await params;
  const { created } = await searchParams;

  const result = await getEvent(id);
  if ('error' in result) {
    if (result.error === 'Unauthorized') redirect('/login');
    notFound();
  }

  const { event } = result;
  const contributorUrl = buildContributorUrl(event.slug);
  const qrDataUrl = await generateContributorQr(contributorUrl);
  const whatsapp = buildWhatsAppShare({
    honoreeName: event.honoreeName,
    occasionType: event.occasionType,
    contributorUrl,
    submissionDeadline: event.submissionDeadline,
  });
  const email = buildEmailShare({
    honoreeName: event.honoreeName,
    occasionType: event.occasionType,
    contributorUrl,
    submissionDeadline: event.submissionDeadline,
  });

  const noun = occasionNouns[event.occasionType] ?? 'tribute';
  const occasionLabel = occasionLabels[event.occasionType] ?? noun;

  return (
    <main className="px-6 py-12 max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            {created && (
              <p className="text-sm text-brand-saffron mb-2">Your event is ready to share.</p>
            )}
            <h1 className="font-display text-3xl font-semibold text-brand-ink">
              {event.honoreeName}&apos;s {occasionLabel} tribute
            </h1>
          </div>
          <span className={`shrink-0 text-xs font-medium px-2 py-1 rounded-full mt-1 ${
            event.status === 'ACTIVE'
              ? 'bg-green-100 text-green-700'
              : 'bg-brand-saffron/10 text-brand-saffron'
          }`}>
            {event.status === 'ACTIVE' ? 'Active' : 'Draft'}
          </span>
        </div>
        {event.status === 'DRAFT' ? (
          <div className="mt-3">
            <p className="text-brand-stone text-sm mb-3">
              One payment activates your event and opens it to contributors.
            </p>
            <PayButton eventId={event.id} />
          </div>
        ) : (
          <p className="text-green-700 text-sm mt-2 font-medium">Active — accepting contributions.</p>
        )}
        <Link href="/dashboard" className="text-xs text-brand-stone/70 hover:text-brand-ink mt-1 inline-block">
          ← Back to My Events
        </Link>
      </div>

      <div className="space-y-4">
        {/* Contributor link */}
        <SectionCard title="Your event link" icon={<LinkIcon size={18} />}>
          <p className="text-xs text-brand-stone mb-2">Share this link so contributors can submit wishes and photos.</p>
          <div className="flex items-center gap-2 bg-brand-stone/5 rounded-lg px-3 py-2">
            <code className="flex-1 text-xs text-brand-ink break-all">{contributorUrl}</code>
            <CopyButton text={contributorUrl} />
          </div>
        </SectionCard>

        {/* QR code */}
        <SectionCard title="QR code" icon={<QrCode size={18} />}>
          <p className="text-xs text-brand-stone mb-3">Scan to open the contributor form.</p>
          <div className="flex justify-center">
            <Image src={qrDataUrl} alt="Contributor QR code" width={200} height={200} unoptimized />
          </div>
        </SectionCard>

        {/* WhatsApp */}
        <SectionCard title="Share on WhatsApp" icon={<Share2 size={18} />}>
          <div className="bg-brand-stone/5 rounded-lg px-3 py-2 mb-3 text-xs text-brand-ink">
            {whatsapp.message}
          </div>
          <div className="flex items-center gap-2">
            <a
              href={whatsapp.waLink}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-[#25D366] text-white text-xs font-medium px-4 py-2 rounded-lg hover:opacity-90 transition-opacity"
            >
              Share on WhatsApp
            </a>
            <CopyButton text={whatsapp.message} label="Copy message" />
          </div>
        </SectionCard>

        {/* Email share */}
        <SectionCard title="Share via email" icon={<Mail size={18} />}>
          <div className="space-y-3">
            <div>
              <p className="text-xs font-medium text-brand-stone mb-1">Subject</p>
              <div className="flex items-center gap-2 bg-brand-stone/5 rounded-lg px-3 py-2">
                <span className="flex-1 text-xs text-brand-ink">{email.subject}</span>
                <CopyButton text={email.subject} />
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-brand-stone mb-1">Body</p>
              <div className="flex items-start gap-2 bg-brand-stone/5 rounded-lg px-3 py-2">
                <pre className="flex-1 text-xs text-brand-ink whitespace-pre-wrap font-sans">{email.body}</pre>
                <CopyButton text={email.body} />
              </div>
            </div>
            <a
              href={`mailto:?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`}
              className="inline-block text-xs text-brand-saffron hover:underline"
            >
              Open in email client
            </a>
          </div>
        </SectionCard>

        {/* Details summary */}
        <SectionCard title="Event details" icon={<CalendarDays size={18} />}>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div>
              <dt className="text-brand-stone text-xs">Occasion</dt>
              <dd className="text-brand-ink mt-0.5">{occasionLabel}</dd>
            </div>
            <div>
              <dt className="text-brand-stone text-xs">Event date</dt>
              <dd className="text-brand-ink mt-0.5">{formatDate(event.eventDate)}</dd>
            </div>
            <div>
              <dt className="text-brand-stone text-xs">Submission deadline</dt>
              <dd className="text-brand-ink mt-0.5">{formatDate(event.submissionDeadline)}</dd>
            </div>
            <div>
              <dt className="text-brand-stone text-xs">Delivery date</dt>
              <dd className="text-brand-ink mt-0.5">{formatDate(event.deliveryDate)}</dd>
            </div>
            <div>
              <dt className="text-brand-stone text-xs flex items-center gap-1"><Users size={12} /> Expected contributors</dt>
              <dd className="text-brand-ink mt-0.5">{event.expectedContributors}</dd>
            </div>
            <div>
              <dt className="text-brand-stone text-xs">Theme</dt>
              <dd className="text-brand-ink mt-0.5">{event.theme}</dd>
            </div>
            <div>
              <dt className="text-brand-stone text-xs">Music mood</dt>
              <dd className="text-brand-ink mt-0.5">{event.musicMood}</dd>
            </div>
            {event.package && (
              <div className="col-span-2">
                <dt className="text-brand-stone text-xs flex items-center gap-1"><Package size={12} /> Package</dt>
                <dd className="text-brand-ink mt-0.5">
                  {event.package.name}
                  <span className="text-brand-stone text-xs ml-2">
                    · Delivery in {event.package.deliverySlaDays} days
                  </span>
                </dd>
              </div>
            )}
          </dl>
        </SectionCard>
      </div>
    </main>
  );
}
