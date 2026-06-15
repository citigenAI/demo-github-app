import { describe, it, expect } from 'vitest';
import { isAllowedTransition } from '@/lib/submission-transitions';

describe('Submission status transition matrix', () => {
  it('PENDING can move to APPROVED, REJECTED, FLAGGED', () => {
    expect(isAllowedTransition('PENDING', 'APPROVED')).toBe(true);
    expect(isAllowedTransition('PENDING', 'REJECTED')).toBe(true);
    expect(isAllowedTransition('PENDING', 'FLAGGED')).toBe(true);
  });

  it('APPROVED can move to REJECTED or FLAGGED', () => {
    expect(isAllowedTransition('APPROVED', 'REJECTED')).toBe(true);
    expect(isAllowedTransition('APPROVED', 'FLAGGED')).toBe(true);
    expect(isAllowedTransition('APPROVED', 'PENDING')).toBe(false);
  });

  it('REJECTED can move back to APPROVED or to FLAGGED', () => {
    expect(isAllowedTransition('REJECTED', 'APPROVED')).toBe(true);
    expect(isAllowedTransition('REJECTED', 'FLAGGED')).toBe(true);
    expect(isAllowedTransition('REJECTED', 'PENDING')).toBe(false);
  });

  it('FLAGGED can move to APPROVED or REJECTED', () => {
    expect(isAllowedTransition('FLAGGED', 'APPROVED')).toBe(true);
    expect(isAllowedTransition('FLAGGED', 'REJECTED')).toBe(true);
    expect(isAllowedTransition('FLAGGED', 'PENDING')).toBe(false);
  });

  it('rejects same-status transitions (no-op)', () => {
    expect(isAllowedTransition('PENDING', 'PENDING')).toBe(false);
    expect(isAllowedTransition('APPROVED', 'APPROVED')).toBe(false);
    expect(isAllowedTransition('REJECTED', 'REJECTED')).toBe(false);
    expect(isAllowedTransition('FLAGGED', 'FLAGGED')).toBe(false);
  });

  it('rejects unknown status', () => {
    expect(isAllowedTransition('PENDING', 'BOGUS')).toBe(false);
    expect(isAllowedTransition('UNKNOWN', 'APPROVED')).toBe(false);
  });
});
