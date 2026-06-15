import Link from 'next/link';
import { db } from '@/lib/db';
import { computeSlaRisk, slaRiskRank, daysUntil, type SlaRisk } from '@/lib/sla';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  DEADLINE_PASSED: 'Deadline passed',
  AWAITING_ROUTING_APPROVAL: 'Awaiting routing',
  AI_ROUTED: 'AI routed',
  MANUAL_ROUTED: 'Manual routed',
  EDITOR_ASSIGNED: 'Editor assigned',
  EDITING_IN_PROGRESS: 'Editing',
  FINAL_VIDEO_UPLOADED: 'Final uploaded',
  IN_REVIEW: 'In review',
  DELIVERED: 'Delivered',
};

const RISK_STYLE: Record<SlaRisk, string> = {
  RED: 'bg-red-100 text-red-800 border-red-200',
  AMBER: 'bg-amber-100 text-amber-800 border-amber-200',
  GREEN: 'bg-green-100 text-green-800 border-green-200',
};

function formatDate(date: Date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export default async function AdminEventsPage() {
  const events = await db.event.findMany({
    select: {
      id: true,
      name: true,
      honoreeName: true,
      occasionType: true,
      status: true,
      paymentStatus: true,
      eventDate: true,
      submissionDeadline: true,
      deliveryDate: true,
      expectedContributors: true,
      organizer: { select: { name: true, email: true } },
      _count: { select: { submissions: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const now = new Date();
  const enriched = events.map((e) => ({
    ...e,
    risk: computeSlaRisk({ deliveryDate: e.deliveryDate, status: e.status, now }),
    daysToDelivery: daysUntil(e.deliveryDate, now),
  }));

  enriched.sort(
    (a, b) => slaRiskRank(a.risk) - slaRiskRank(b.risk) || a.daysToDelivery - b.daysToDelivery,
  );

  const counts = {
    total: enriched.length,
    red: enriched.filter((e) => e.risk === 'RED').length,
    amber: enriched.filter((e) => e.risk === 'AMBER').length,
    delivered: enriched.filter((e) => e.status === 'DELIVERED').length,
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-brand-ink">Events</h1>
        <p className="text-brand-stone text-sm mt-1">
          {counts.total} total · {counts.red} at-risk · {counts.amber} watch · {counts.delivered} delivered
        </p>
      </div>

      {enriched.length === 0 ? (
        <div className="bg-white border border-brand-stone/10 rounded-xl p-8 text-center text-brand-stone">
          No events yet.
        </div>
      ) : (
        <div className="bg-white border border-brand-stone/10 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-brand-stone/10 bg-brand-stone/5">
              <tr className="text-left text-xs uppercase tracking-wide text-brand-stone">
                <th className="px-4 py-3">Risk</th>
                <th className="px-4 py-3">Event</th>
                <th className="px-4 py-3">Organizer</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Submissions</th>
                <th className="px-4 py-3">Deadline</th>
                <th className="px-4 py-3">Delivery</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-brand-stone/10">
              {enriched.map((e) => (
                <tr key={e.id} className="hover:bg-brand-stone/[0.02]">
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center text-[10px] font-medium px-2 py-0.5 rounded-full border ${RISK_STYLE[e.risk]}`}
                      aria-label={`SLA risk ${e.risk}`}
                    >
                      {e.risk}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/events/${e.id}`}
                      className="font-medium text-brand-ink hover:text-brand-saffron"
                    >
                      {e.name ?? `${e.honoreeName}'s tribute`}
                    </Link>
                    <div className="text-xs text-brand-stone">{e.honoreeName} · {e.occasionType}</div>
                  </td>
                  <td className="px-4 py-3 text-brand-ink">
                    <div>{e.organizer.name ?? e.organizer.email}</div>
                    {e.organizer.name && (
                      <div className="text-xs text-brand-stone">{e.organizer.email}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-brand-ink">{STATUS_LABEL[e.status] ?? e.status}</td>
                  <td className="px-4 py-3 text-right">
                    <span className="text-brand-ink font-medium">{e._count.submissions}</span>
                    <span className="text-brand-stone"> / {e.expectedContributors}</span>
                  </td>
                  <td className="px-4 py-3 text-brand-stone">{formatDate(e.submissionDeadline)}</td>
                  <td className="px-4 py-3">
                    <div className="text-brand-ink">{formatDate(e.deliveryDate)}</div>
                    <div className="text-xs text-brand-stone">
                      {e.daysToDelivery < 0
                        ? `${Math.abs(e.daysToDelivery)} days overdue`
                        : e.daysToDelivery === 0
                          ? 'today'
                          : `${e.daysToDelivery} days`}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
