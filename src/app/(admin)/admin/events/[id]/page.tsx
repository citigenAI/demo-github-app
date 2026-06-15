import { notFound } from 'next/navigation';
import Link from 'next/link';
import { db } from '@/lib/db';
import { computeSlaRisk, daysUntil } from '@/lib/sla';
import { SubmissionActions } from './SubmissionActions';

function fmtDate(d: Date) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default async function AdminEventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const event = await db.event.findUnique({
    where: { id },
    include: {
      organizer: { select: { name: true, email: true } },
      package: { select: { name: true, deliverySlaDays: true } },
      submissions: {
        orderBy: { submittedAt: 'desc' },
        select: {
          id: true,
          contributorName: true,
          relationship: true,
          email: true,
          submittedAt: true,
          status: true,
          adminNote: true,
          mediaItems: { select: { id: true, type: true, sizeBytes: true, originalName: true } },
        },
      },
    },
  });
  if (!event) notFound();

  const now = new Date();
  const risk = computeSlaRisk({ deliveryDate: event.deliveryDate, status: event.status, now });
  const days = daysUntil(event.deliveryDate, now);

  const allMedia = event.submissions.flatMap((s) => s.mediaItems);
  const byType = {
    PHOTO: allMedia.filter((m) => m.type === 'PHOTO').length,
    VOICE: allMedia.filter((m) => m.type === 'VOICE').length,
    VIDEO: allMedia.filter((m) => m.type === 'VIDEO').length,
  };

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin" className="text-xs text-brand-stone hover:text-brand-ink">← All events</Link>
        <div className="mt-1 flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-semibold text-brand-ink">
              {event.name ?? `${event.honoreeName}'s tribute`}
            </h1>
            <p className="text-brand-stone text-sm mt-0.5">
              {event.honoreeName} · {event.occasionType} · organized by {event.organizer.name ?? event.organizer.email}
            </p>
          </div>
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
              risk === 'RED' ? 'bg-red-100 text-red-800 border-red-200' :
              risk === 'AMBER' ? 'bg-amber-100 text-amber-800 border-amber-200' :
              'bg-green-100 text-green-800 border-green-200'
            }`}
          >
            {risk}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="bg-white border border-brand-stone/10 rounded-xl p-4">
          <p className="text-xs text-brand-stone">Status</p>
          <p className="text-brand-ink font-medium mt-0.5">{event.status}</p>
        </div>
        <div className="bg-white border border-brand-stone/10 rounded-xl p-4">
          <p className="text-xs text-brand-stone">Submissions</p>
          <p className="text-brand-ink font-medium mt-0.5">
            {event.submissions.length} / {event.expectedContributors}
          </p>
        </div>
        <div className="bg-white border border-brand-stone/10 rounded-xl p-4">
          <p className="text-xs text-brand-stone">Deadline</p>
          <p className="text-brand-ink mt-0.5">{fmtDate(event.submissionDeadline)}</p>
        </div>
        <div className="bg-white border border-brand-stone/10 rounded-xl p-4">
          <p className="text-xs text-brand-stone">Delivery</p>
          <p className="text-brand-ink mt-0.5">{fmtDate(event.deliveryDate)}</p>
          <p className="text-xs text-brand-stone">
            {days < 0 ? `${Math.abs(days)} days overdue` : days === 0 ? 'today' : `${days} days`}
          </p>
        </div>
        <div className="bg-white border border-brand-stone/10 rounded-xl p-4">
          <p className="text-xs text-brand-stone">Media</p>
          <p className="text-brand-ink mt-0.5">{allMedia.length} files</p>
          <p className="text-xs text-brand-stone">
            {byType.PHOTO} photo · {byType.VOICE} voice · {byType.VIDEO} video
          </p>
        </div>
      </div>

      <div className="bg-white border border-brand-stone/10 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-brand-stone/10">
          <h2 className="font-display text-base font-semibold text-brand-ink">Contributors</h2>
        </div>
        {event.submissions.length === 0 ? (
          <div className="p-8 text-center text-brand-stone text-sm">No submissions yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-brand-stone/5">
              <tr className="text-left text-xs uppercase tracking-wide text-brand-stone">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Relationship</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Submitted</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Files</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-brand-stone/10">
              {event.submissions.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-3 text-brand-ink">{s.contributorName}</td>
                  <td className="px-4 py-3 text-brand-ink">{s.relationship}</td>
                  <td className="px-4 py-3 text-brand-stone">{s.email ?? '—'}</td>
                  <td className="px-4 py-3 text-brand-stone">{fmtDate(s.submittedAt)}</td>
                  <td className="px-4 py-3">
                    <SubmissionActions
                      submissionId={s.id}
                      initialStatus={s.status}
                      initialNote={s.adminNote}
                    />
                  </td>
                  <td className="px-4 py-3 text-right text-brand-ink">{s.mediaItems.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {allMedia.length > 0 && (
        <div className="bg-white border border-brand-stone/10 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-brand-stone/10">
            <h2 className="font-display text-base font-semibold text-brand-ink">Media files</h2>
          </div>
          <ul className="divide-y divide-brand-stone/10">
            {allMedia.map((m) => (
              <li key={m.id} className="px-5 py-2 flex items-center justify-between text-sm">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-brand-saffron/10 text-brand-saffron">
                    {m.type}
                  </span>
                  <span className="truncate text-brand-ink">{m.originalName}</span>
                </div>
                <span className="text-xs text-brand-stone shrink-0 ml-2">{humanSize(m.sizeBytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
