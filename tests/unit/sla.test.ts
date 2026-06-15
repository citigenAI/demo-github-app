import { describe, it, expect } from 'vitest';
import { computeSlaRisk, slaRiskRank, daysUntil } from '@/lib/sla';

const NOW = new Date('2026-06-14T12:00:00Z');

describe('computeSlaRisk', () => {
  it('returns GREEN for DELIVERED regardless of date', () => {
    expect(
      computeSlaRisk({
        deliveryDate: new Date('2020-01-01'),
        status: 'DELIVERED',
        now: NOW,
      }),
    ).toBe('GREEN');
  });

  it('returns RED when delivery date is in the past', () => {
    expect(
      computeSlaRisk({
        deliveryDate: new Date('2026-06-13T12:00:00Z'),
        status: 'ACTIVE',
        now: NOW,
      }),
    ).toBe('RED');
  });

  it('returns RED when 2 or fewer days remain', () => {
    expect(
      computeSlaRisk({
        deliveryDate: new Date('2026-06-15T12:00:00Z'),
        status: 'ACTIVE',
        now: NOW,
      }),
    ).toBe('RED');
  });

  it('returns AMBER when 3-7 days remain', () => {
    expect(
      computeSlaRisk({
        deliveryDate: new Date('2026-06-20T12:00:00Z'),
        status: 'ACTIVE',
        now: NOW,
      }),
    ).toBe('AMBER');
  });

  it('returns GREEN when more than 7 days remain', () => {
    expect(
      computeSlaRisk({
        deliveryDate: new Date('2026-07-01T12:00:00Z'),
        status: 'ACTIVE',
        now: NOW,
      }),
    ).toBe('GREEN');
  });
});

describe('slaRiskRank', () => {
  it('orders RED < AMBER < GREEN', () => {
    expect(slaRiskRank('RED')).toBe(0);
    expect(slaRiskRank('AMBER')).toBe(1);
    expect(slaRiskRank('GREEN')).toBe(2);
  });
});

describe('daysUntil', () => {
  it('counts whole days to future date', () => {
    expect(
      daysUntil(new Date('2026-06-20T12:00:00Z'), NOW),
    ).toBe(6);
  });
  it('returns negative for past dates', () => {
    expect(daysUntil(new Date('2026-06-10T12:00:00Z'), NOW)).toBe(-4);
  });
});
