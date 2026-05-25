import { config } from '@/config';

export const occasionNouns: Record<string, string> = {
  GRADUATION: 'graduation',
  BIRTHDAY: 'birthday',
  WEDDING: 'wedding',
  ANNIVERSARY: 'anniversary',
  RETIREMENT: 'retirement',
  BUSINESS_EVENT: 'business event',
};

export const occasionLabels: Record<string, string> = {
  GRADUATION: 'Graduation',
  BIRTHDAY: 'Birthday',
  WEDDING: 'Wedding',
  ANNIVERSARY: 'Anniversary',
  RETIREMENT: 'Retirement',
  BUSINESS_EVENT: 'Business Event',
};

// Default event name used when the organizer leaves it blank, e.g. "Nirvan's Birthday".
// Deliberately omits the word "tribute" so the share copy ("a tribute for {name}") reads well.
export function autoEventName(honoreeName: string, occasionType: string): string {
  return `${honoreeName}'s ${occasionLabels[occasionType] ?? 'Tribute'}`;
}

const businessOccasions = new Set(['BUSINESS_EVENT', 'ANNIVERSARY']);

export function buildContributorUrl(slug: string): string {
  return `${config.app.publicUrl}/contribute/${slug}`;
}

function formatDeadline(deadline: Date): string {
  return deadline.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

export interface ShareInput {
  honoreeName: string;
  occasionType: string;
  contributorUrl: string;
  submissionDeadline: Date;
  // Optional organizer-set event name (e.g. "Nirvan's 10th Birthday"). When present it
  // replaces the generic "{occasion} tribute for {honoree}" phrasing.
  eventName?: string | null;
}

export interface WhatsAppShare {
  message: string;
  waLink: string;
}

export function buildWhatsAppShare(input: ShareInput): WhatsAppShare {
  const { honoreeName, occasionType, contributorUrl, submissionDeadline, eventName } = input;
  const noun = occasionNouns[occasionType] ?? 'tribute';
  const isBusiness = businessOccasions.has(occasionType);
  const callToAction = isBusiness
    ? 'Add your contribution'
    : 'Add your wish, photo, or message';
  const deadline = formatDeadline(submissionDeadline);
  const subject = eventName ? `a tribute for ${eventName}` : `a ${noun} tribute for ${honoreeName}`;
  const message = `Hi — I'm putting together ${subject}. ${callToAction} here before ${deadline}: ${contributorUrl}`;
  const waLink = `https://wa.me/?text=${encodeURIComponent(message)}`;
  return { message, waLink };
}

export interface EmailShare {
  subject: string;
  body: string;
}

export function buildEmailShare(input: ShareInput): EmailShare {
  const { honoreeName, occasionType, contributorUrl, submissionDeadline, eventName } = input;
  const noun = occasionNouns[occasionType] ?? 'tribute';
  const isBusiness = businessOccasions.has(occasionType);
  const callToAction = isBusiness
    ? 'Share your contribution, message, or memory'
    : 'Share a message, photo, or memory';
  const deadline = formatDeadline(submissionDeadline);
  const subject = eventName ? `Add to ${eventName} tribute` : `Add to ${honoreeName}'s ${noun} tribute`;
  const intro = eventName ? `a tribute for ${eventName}` : `a ${noun} tribute for ${honoreeName}`;
  const body = [
    'Hi,',
    '',
    `I'm putting together ${intro} and would love for you to contribute.`,
    '',
    `${callToAction} here before ${deadline}:`,
    contributorUrl,
    '',
    '— Swara Magical Memories',
    'by Swara Media',
  ].join('\n');
  return { subject, body };
}
