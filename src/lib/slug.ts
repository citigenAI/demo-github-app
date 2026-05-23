const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BASE_LENGTH = 60;
const SUFFIX_LENGTH = 6;
const BASE36_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function randomBase36(length: number): string {
  return Array.from(
    { length },
    () => BASE36_CHARS[Math.floor(Math.random() * BASE36_CHARS.length)],
  ).join('');
}

export function generateSlug(honoreeName: string, occasionType: string): string {
  const nameSlug = slugify(honoreeName);
  const occasionSlug = occasionType.toLowerCase().replace(/_/g, '-');
  const base = nameSlug ? `${nameSlug}-${occasionSlug}` : occasionSlug || 'event';
  const trimmedBase = base.slice(0, MAX_BASE_LENGTH).replace(/-+$/, '');
  const suffix = randomBase36(SUFFIX_LENGTH);
  return `${trimmedBase}-${suffix}`;
}

export function isValidSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug);
}
