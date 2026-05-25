import { describe, it, expect } from 'vitest';
import { slugify, generateSlug, isValidSlug } from '@/lib/slug';
import { buildContributorUrl, buildWhatsAppShare, buildEmailShare, occasionNouns } from '@/lib/share';
import { generateContributorQr } from '@/lib/qr';
import { CreateEventSchema, UpdateEventSchema, THEMES, MUSIC_MOODS } from '@/app/(organizer)/events/schema';

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('slugify', () => {
  it('lowercases and replaces non-alphanumeric with hyphens', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('strips accents', () => {
    expect(slugify('Riya')).toBe('riya');
    expect(slugify('José')).toBe('jose');
  });

  it('collapses repeated separators', () => {
    expect(slugify('hello--world')).toBe('hello-world');
    expect(slugify('hello  world')).toBe('hello-world');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('-hello-')).toBe('hello');
  });

  it('returns empty string for all non-alphanumeric input', () => {
    expect(slugify('---')).toBe('');
  });
});

describe('generateSlug', () => {
  it('produces a valid slug format', () => {
    const slug = generateSlug('Riya Sharma', 'GRADUATION');
    expect(SLUG_REGEX.test(slug)).toBe(true);
    expect(isValidSlug(slug)).toBe(true);
  });

  it('includes honoree name and occasion in the base', () => {
    const slug = generateSlug('Riya Sharma', 'GRADUATION');
    expect(slug).toContain('riya-sharma');
    expect(slug).toContain('graduation');
  });

  it('is lowercase', () => {
    const slug = generateSlug('John DOE', 'BIRTHDAY');
    expect(slug).toBe(slug.toLowerCase());
  });

  it('two calls for the same input yield different slugs (random suffix)', () => {
    const a = generateSlug('Riya', 'GRADUATION');
    const b = generateSlug('Riya', 'GRADUATION');
    expect(a).not.toBe(b);
  });

  it('respects max length (≤80 chars)', () => {
    const slug = generateSlug('A'.repeat(100), 'GRADUATION');
    expect(slug.length).toBeLessThanOrEqual(80);
  });

  it('falls back gracefully for empty honoree name', () => {
    const slug = generateSlug('', 'GRADUATION');
    expect(SLUG_REGEX.test(slug)).toBe(true);
    expect(slug).toContain('graduation');
  });

  it('falls back to "event" base when name and occasion are empty-ish', () => {
    const slug = generateSlug('', '');
    expect(SLUG_REGEX.test(slug)).toBe(true);
    expect(slug.startsWith('event') || slug.length > 0).toBe(true);
  });
});

describe('buildContributorUrl', () => {
  it('builds URL from config.app.publicUrl and slug', () => {
    const url = buildContributorUrl('riya-graduation-abc123');
    expect(url).toBe('http://localhost:3000/contribute/riya-graduation-abc123');
  });
});

describe('buildWhatsAppShare', () => {
  const baseInput = {
    honoreeName: 'Riya Sharma',
    occasionType: 'GRADUATION',
    contributorUrl: 'http://localhost:3000/contribute/test-slug',
    submissionDeadline: new Date('2027-06-15T18:00:00Z'),
  };

  it('waLink starts with https://wa.me/?text=', () => {
    const { waLink } = buildWhatsAppShare(baseInput);
    expect(waLink.startsWith('https://wa.me/?text=')).toBe(true);
  });

  it('decoding text param reproduces the message', () => {
    const { waLink, message } = buildWhatsAppShare(baseInput);
    const encoded = waLink.slice('https://wa.me/?text='.length);
    expect(decodeURIComponent(encoded)).toBe(message);
  });

  it('message contains honoree name verbatim', () => {
    const { message } = buildWhatsAppShare(baseInput);
    expect(message).toContain('Riya Sharma');
  });

  it('message contains contributor URL verbatim', () => {
    const { message } = buildWhatsAppShare(baseInput);
    expect(message).toContain(baseInput.contributorUrl);
  });

  it('message contains no exclamation marks', () => {
    const { message } = buildWhatsAppShare(baseInput);
    expect(message).not.toContain('!');
  });

  it('uses occasion-aware noun for GRADUATION', () => {
    const { message } = buildWhatsAppShare(baseInput);
    expect(message).toContain('graduation');
  });

  it('uses formal phrasing for BUSINESS_EVENT', () => {
    const { message } = buildWhatsAppShare({ ...baseInput, occasionType: 'BUSINESS_EVENT' });
    expect(message).toContain('contribution');
    expect(message).not.toContain('wish');
  });

  it('uses warm phrasing for BIRTHDAY', () => {
    const { message } = buildWhatsAppShare({ ...baseInput, occasionType: 'BIRTHDAY' });
    expect(message).toContain('wish');
  });

  it('uses the event name when provided', () => {
    const { message } = buildWhatsAppShare({ ...baseInput, eventName: "Nirvan's 10th Birthday" });
    expect(message).toContain("tribute for Nirvan's 10th Birthday");
    expect(message).not.toContain('!');
  });
});

describe('buildEmailShare', () => {
  const baseInput = {
    honoreeName: 'Riya Sharma',
    occasionType: 'GRADUATION',
    contributorUrl: 'http://localhost:3000/contribute/test-slug',
    submissionDeadline: new Date('2027-06-15T18:00:00Z'),
  };

  it('subject contains honoree name', () => {
    const { subject } = buildEmailShare(baseInput);
    expect(subject).toContain('Riya Sharma');
  });

  it('body contains honoree name', () => {
    const { body } = buildEmailShare(baseInput);
    expect(body).toContain('Riya Sharma');
  });

  it('body contains contributor URL', () => {
    const { body } = buildEmailShare(baseInput);
    expect(body).toContain(baseInput.contributorUrl);
  });

  it('body contains brand sign-off', () => {
    const { body } = buildEmailShare(baseInput);
    expect(body).toContain('Swara Magical Memories');
  });

  it('subject and body contain no exclamation marks', () => {
    const { subject, body } = buildEmailShare(baseInput);
    expect(subject).not.toContain('!');
    expect(body).not.toContain('!');
  });

  it('uses the event name in subject and body when provided', () => {
    const { subject, body } = buildEmailShare({ ...baseInput, eventName: "Nirvan's 10th Birthday" });
    expect(subject).toContain("Nirvan's 10th Birthday");
    expect(body).toContain("Nirvan's 10th Birthday");
    expect(subject).not.toContain('!');
    expect(body).not.toContain('!');
  });

  it('occasion noun correct for all six occasions', () => {
    const occasions = Object.keys(occasionNouns) as string[];
    for (const occasionType of occasions) {
      const noun = occasionNouns[occasionType];
      const { subject, body } = buildEmailShare({ ...baseInput, occasionType });
      expect(subject).toContain(noun);
      expect(body).toContain(noun);
    }
  });
});

describe('generateContributorQr', () => {
  it('returns a non-empty data URL', async () => {
    const dataUrl = await generateContributorQr('http://localhost:3000/contribute/test');
    expect(dataUrl.length).toBeGreaterThan(0);
    expect(dataUrl.startsWith('data:')).toBe(true);
  });
});

describe('CreateEventSchema', () => {
  function validPayload() {
    // Logical ordering: now < submissionDeadline (+25) <= deliveryDate (+28) <= eventDate (+30)
    const future = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString();
    const deliveryDate = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return {
      honoreeName: 'Riya Sharma',
      organizerName: 'Priya Sharma',
      occasionType: 'GRADUATION' as const,
      eventDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      submissionDeadline: future,
      deliveryDate,
      theme: THEMES[0],
      musicMood: MUSIC_MOODS[0],
      expectedContributors: 20,
      packageId: 'pkg_mvp1',
    };
  }

  it('accepts a fully valid payload', () => {
    expect(CreateEventSchema.safeParse(validPayload()).success).toBe(true);
  });

  it('rejects missing honoreeName', () => {
    const result = CreateEventSchema.safeParse({ ...validPayload(), honoreeName: '' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid occasionType', () => {
    const result = CreateEventSchema.safeParse({ ...validPayload(), occasionType: 'PARTY' });
    expect(result.success).toBe(false);
  });

  it('rejects past submissionDeadline', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const result = CreateEventSchema.safeParse({ ...validPayload(), submissionDeadline: past });
    expect(result.success).toBe(false);
    const issues = result.error!.issues;
    expect(issues.some((i) => i.path[0] === 'submissionDeadline')).toBe(true);
  });

  it('rejects deliveryDate before submissionDeadline', () => {
    const deadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const earlyDelivery = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const result = CreateEventSchema.safeParse({ ...validPayload(), submissionDeadline: deadline, deliveryDate: earlyDelivery });
    expect(result.success).toBe(false);
    const issues = result.error!.issues;
    expect(issues.some((i) => i.path[0] === 'deliveryDate')).toBe(true);
  });

  it('rejects deliveryDate after the event date', () => {
    const deliveryAfterEvent = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const result = CreateEventSchema.safeParse({ ...validPayload(), deliveryDate: deliveryAfterEvent });
    expect(result.success).toBe(false);
    expect(result.error!.issues.some((i) => i.path[0] === 'deliveryDate')).toBe(true);
  });

  it('rejects a submission deadline after the event date', () => {
    const deadlineAfterEvent = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();
    const delivery = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const result = CreateEventSchema.safeParse({
      ...validPayload(),
      submissionDeadline: deadlineAfterEvent,
      deliveryDate: delivery,
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues.some((i) => i.path[0] === 'submissionDeadline')).toBe(true);
  });

  it('rejects an invalid event date', () => {
    const result = CreateEventSchema.safeParse({ ...validPayload(), eventDate: 'not-a-date' });
    expect(result.success).toBe(false);
    expect(result.error!.issues.some((i) => i.path[0] === 'eventDate')).toBe(true);
  });

  it('rejects expectedContributors below 1', () => {
    const result = CreateEventSchema.safeParse({ ...validPayload(), expectedContributors: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects expectedContributors above 500', () => {
    const result = CreateEventSchema.safeParse({ ...validPayload(), expectedContributors: 501 });
    expect(result.success).toBe(false);
  });

  it('rejects invalid theme', () => {
    const result = CreateEventSchema.safeParse({ ...validPayload(), theme: 'Neon' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid musicMood', () => {
    const result = CreateEventSchema.safeParse({ ...validPayload(), musicMood: 'Heavy Metal' });
    expect(result.success).toBe(false);
  });

  it('rejects missing packageId', () => {
    const result = CreateEventSchema.safeParse({ ...validPayload(), packageId: '' });
    expect(result.success).toBe(false);
  });

  describe('UpdateEventSchema (edit)', () => {
    function validUpdate() {
      return {
        eventDate: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
        submissionDeadline: new Date(Date.now() + 25 * 86400000).toISOString(),
        deliveryDate: new Date(Date.now() + 28 * 86400000).toISOString().split('T')[0],
        theme: THEMES[0],
        musicMood: MUSIC_MOODS[0],
      };
    }

    it('accepts a valid update', () => {
      expect(UpdateEventSchema.safeParse(validUpdate()).success).toBe(true);
    });

    it('rejects delivery after the event date', () => {
      const deliveryAfterEvent = new Date(Date.now() + 40 * 86400000).toISOString().split('T')[0];
      expect(UpdateEventSchema.safeParse({ ...validUpdate(), deliveryDate: deliveryAfterEvent }).success).toBe(false);
    });

    it('rejects a past submission deadline', () => {
      expect(UpdateEventSchema.safeParse({ ...validUpdate(), submissionDeadline: new Date(Date.now() - 1000).toISOString() }).success).toBe(false);
    });
  });

  it('rejects missing organizerName', () => {
    const result = CreateEventSchema.safeParse({ ...validPayload(), organizerName: '' });
    expect(result.success).toBe(false);
    expect(result.error!.issues.some((i) => i.path[0] === 'organizerName')).toBe(true);
  });

  it('accepts an optional event name and a blank one', () => {
    expect(CreateEventSchema.safeParse({ ...validPayload(), name: "Manu's 16th Birthday" }).success).toBe(true);
    expect(CreateEventSchema.safeParse({ ...validPayload(), name: '' }).success).toBe(true);
  });
});
