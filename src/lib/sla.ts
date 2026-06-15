export type SlaRisk = 'GREEN' | 'AMBER' | 'RED';

/**
 * Computes SLA risk for an event based on how close `deliveryDate` is to `now`,
 * accounting for `status`. Already-DELIVERED events are GREEN.
 *
 * Thresholds:
 *   - DELIVERED → GREEN
 *   - deliveryDate already passed (overdue) → RED
 *   - <= 2 days remaining → RED
 *   - <= 7 days remaining → AMBER
 *   - otherwise → GREEN
 */
export function computeSlaRisk(args: {
  deliveryDate: Date;
  status: string;
  now?: Date;
}): SlaRisk {
  if (args.status === 'DELIVERED') return 'GREEN';
  const now = args.now ?? new Date();
  const msRemaining = args.deliveryDate.getTime() - now.getTime();
  const daysRemaining = msRemaining / (1000 * 60 * 60 * 24);
  if (daysRemaining < 0) return 'RED';
  if (daysRemaining <= 2) return 'RED';
  if (daysRemaining <= 7) return 'AMBER';
  return 'GREEN';
}

export function slaRiskRank(r: SlaRisk): number {
  return r === 'RED' ? 0 : r === 'AMBER' ? 1 : 2;
}

export function daysUntil(date: Date, now?: Date): number {
  const base = now ?? new Date();
  return Math.ceil((date.getTime() - base.getTime()) / (1000 * 60 * 60 * 24));
}
