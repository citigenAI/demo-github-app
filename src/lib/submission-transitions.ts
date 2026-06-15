const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  PENDING: new Set(['APPROVED', 'REJECTED', 'FLAGGED']),
  APPROVED: new Set(['REJECTED', 'FLAGGED']),
  REJECTED: new Set(['APPROVED', 'FLAGGED']),
  FLAGGED: new Set(['APPROVED', 'REJECTED']),
};

export function isAllowedTransition(from: string, to: string): boolean {
  if (from === to) return false;
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}
