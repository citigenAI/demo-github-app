import { config } from '@/config';

export const occasionNouns: Record<string, string> = {
  GRADUATION: 'graduation',
  BIRTHDAY: 'birthday',
  WEDDING: 'wedding',
  ANNIVERSARY: 'anniversary',
  RETIREMENT: 'retirement',
  BUSINESS_EVENT: 'business event',
};

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
}

export interface WhatsAppShare {
  message: string;
  waLink: string;
}

export function buildWhatsAppShare(input: ShareInput): WhatsAppShare {
  const { honoreeName, occasionType, contributorUrl, submissionDeadline } = input;
  const noun = occasionNouns[occasionType] ?? 'tribute';
  const isBusiness = businessOccasions.has(occasionType);
  const callToAction = isBusiness
    ? 'Add your contribution'
    : 'Add your wish, photo, or message';
  const deadline = formatDeadline(submissionDeadline);
  const message = `Hi — I'm putting together a ${noun} tribute for ${honoreeName}. ${callToAction} here before ${deadline}: ${contributorUrl}`;
  const waLink = `https://wa.me/?text=${encodeURIComponent(message)}`;
  return { message, waLink };
}

export interface EmailShare {
  subject: string;
  body: string;
}

export function buildEmailShare(input: ShareInput): EmailShare {
  const { honoreeName, occasionType, contributorUrl, submissionDeadline } = input;
  const noun = occasionNouns[occasionType] ?? 'tribute';
  const isBusiness = businessOccasions.has(occasionType);
  const callToAction = isBusiness
    ? 'Share your contribution, message, or memory'
    : 'Share a message, photo, or memory';
  const deadline = formatDeadline(submissionDeadline);
  const subject = `Add to ${honoreeName}'s ${noun} tribute`;
  const body = [
    'Hi,',
    '',
    `I'm putting together a ${noun} tribute for ${honoreeName} and would love for you to contribute.`,
    '',
    `${callToAction} here before ${deadline}:`,
    contributorUrl,
    '',
    '— Swara Magical Memories',
    'by Swara Media',
  ].join('\n');
  return { subject, body };
}
