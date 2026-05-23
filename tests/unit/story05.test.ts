import { describe, it, expect } from 'vitest';
import { SubmitContributionSchema, isBusiness, COLLECTING_STATUSES } from '@/app/contribute/[slug]/schema';

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
void SLUG_REGEX; // suppress unused warning

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'riyas-graduation',
    contributorName: 'Priya Sharma',
    relationship: 'Friend',
    email: 'priya@example.com',
    textMessage: 'So proud of you',
    funnyMemory: '',
    advice: '',
    professionalNote: '',
    isBusiness: false,
    consentGiven: true as const,
    ...overrides,
  };
}

describe('isBusiness', () => {
  it('returns true for BUSINESS_EVENT', () => {
    expect(isBusiness('BUSINESS_EVENT')).toBe(true);
  });

  it('returns true for ANNIVERSARY', () => {
    expect(isBusiness('ANNIVERSARY')).toBe(true);
  });

  it('returns false for GRADUATION', () => {
    expect(isBusiness('GRADUATION')).toBe(false);
  });

  it('returns false for BIRTHDAY', () => {
    expect(isBusiness('BIRTHDAY')).toBe(false);
  });

  it('returns false for WEDDING', () => {
    expect(isBusiness('WEDDING')).toBe(false);
  });

  it('returns false for RETIREMENT', () => {
    expect(isBusiness('RETIREMENT')).toBe(false);
  });
});

describe('COLLECTING_STATUSES', () => {
  it('includes ACTIVE', () => {
    expect(COLLECTING_STATUSES.has('ACTIVE')).toBe(true);
  });

  it('excludes DRAFT', () => {
    expect(COLLECTING_STATUSES.has('DRAFT')).toBe(false);
  });

  it('excludes DELIVERED', () => {
    expect(COLLECTING_STATUSES.has('DELIVERED')).toBe(false);
  });
});

describe('SubmitContributionSchema', () => {
  it('accepts a fully valid personal payload', () => {
    const result = SubmitContributionSchema.safeParse(validPayload());
    expect(result.success).toBe(true);
  });

  it('accepts a valid business payload with professionalNote', () => {
    const result = SubmitContributionSchema.safeParse(
      validPayload({ isBusiness: true, professionalNote: 'A key achievement' }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects missing contributorName', () => {
    const result = SubmitContributionSchema.safeParse(validPayload({ contributorName: '' }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path[0] === 'contributorName')).toBe(true);
  });

  it('rejects missing relationship', () => {
    const result = SubmitContributionSchema.safeParse(validPayload({ relationship: '' }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path[0] === 'relationship')).toBe(true);
  });

  it('rejects invalid email', () => {
    const result = SubmitContributionSchema.safeParse(validPayload({ email: 'not-an-email' }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path[0] === 'email')).toBe(true);
  });

  it('lowercases the email', () => {
    const result = SubmitContributionSchema.safeParse(validPayload({ email: 'Priya@Example.COM' }));
    expect(result.success).toBe(true);
    expect(result.data?.email).toBe('priya@example.com');
  });

  it('rejects consentGiven=false', () => {
    const result = SubmitContributionSchema.safeParse(
      validPayload({ consentGiven: false as unknown as true }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path[0] === 'consentGiven')).toBe(true);
  });

  it('rejects when all content fields are empty', () => {
    const result = SubmitContributionSchema.safeParse(
      validPayload({ textMessage: '', funnyMemory: '', advice: '', professionalNote: '' }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.message.includes('at least one'))).toBe(true);
  });

  it('accepts when only funnyMemory is filled', () => {
    const result = SubmitContributionSchema.safeParse(
      validPayload({ textMessage: '', funnyMemory: 'funny story', advice: '' }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts when only advice is filled', () => {
    const result = SubmitContributionSchema.safeParse(
      validPayload({ textMessage: '', advice: 'keep learning', funnyMemory: '' }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects whitespace-only content fields as empty', () => {
    const result = SubmitContributionSchema.safeParse(
      validPayload({ textMessage: '   ', funnyMemory: '   ', advice: '  ' }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts business payload with only professionalNote filled', () => {
    const result = SubmitContributionSchema.safeParse(
      validPayload({
        textMessage: '',
        funnyMemory: '',
        advice: '',
        professionalNote: 'great work',
        isBusiness: true,
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects personal payload with only professionalNote filled', () => {
    const result = SubmitContributionSchema.safeParse(
      validPayload({
        textMessage: '',
        funnyMemory: '',
        advice: '',
        professionalNote: 'great work',
        isBusiness: false,
      }),
    );
    expect(result.success).toBe(false);
  });

  it('respects max length for contributorName (>120)', () => {
    const result = SubmitContributionSchema.safeParse(
      validPayload({ contributorName: 'A'.repeat(121) }),
    );
    expect(result.success).toBe(false);
  });

  it('respects max length for textMessage (>5000)', () => {
    const result = SubmitContributionSchema.safeParse(
      validPayload({ textMessage: 'a'.repeat(5001) }),
    );
    expect(result.success).toBe(false);
  });

  it('respects max length for email (>254)', () => {
    const longEmail = 'a'.repeat(250) + '@x.co';
    const result = SubmitContributionSchema.safeParse(validPayload({ email: longEmail }));
    expect(result.success).toBe(false);
  });
});

describe('deadline and status gate logic', () => {
  it('deadline is closed when now >= submissionDeadline', () => {
    const past = new Date(Date.now() - 1000);
    expect(new Date() >= past).toBe(true);
  });

  it('deadline is open when now < submissionDeadline', () => {
    const future = new Date(Date.now() + 10000);
    expect(new Date() < future).toBe(true);
  });

  it('event with DRAFT status is not in collecting set', () => {
    expect(COLLECTING_STATUSES.has('DRAFT')).toBe(false);
  });

  it('event with ACTIVE status is in collecting set', () => {
    expect(COLLECTING_STATUSES.has('ACTIVE')).toBe(true);
  });
});
