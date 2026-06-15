'use client';

import { useState, useTransition } from 'react';
import { setSubmissionStatus } from './actions';

interface Props {
  submissionId: string;
  initialStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | 'FLAGGED';
  initialNote: string | null;
}

const STATUS_PILL: Record<string, string> = {
  PENDING: 'bg-brand-stone/10 text-brand-stone',
  APPROVED: 'bg-green-100 text-green-700',
  REJECTED: 'bg-red-100 text-red-700',
  FLAGGED: 'bg-amber-100 text-amber-800',
};

const ALLOWED_FROM: Record<string, Array<'APPROVED' | 'REJECTED' | 'FLAGGED'>> = {
  PENDING: ['APPROVED', 'REJECTED', 'FLAGGED'],
  APPROVED: ['REJECTED', 'FLAGGED'],
  REJECTED: ['APPROVED', 'FLAGGED'],
  FLAGGED: ['APPROVED', 'REJECTED'],
};

const ACTION_LABEL = {
  APPROVED: 'Approve',
  REJECTED: 'Reject',
  FLAGGED: 'Flag',
} as const;

const ACTION_STYLE = {
  APPROVED: 'bg-green-600 text-white hover:bg-green-700',
  REJECTED: 'bg-red-600 text-white hover:bg-red-700',
  FLAGGED: 'bg-amber-500 text-white hover:bg-amber-600',
} as const;

export function SubmissionActions({ submissionId, initialStatus, initialNote }: Props) {
  const [status, setStatus] = useState(initialStatus);
  const [note, setNote] = useState('');
  const [savedNote, setSavedNote] = useState(initialNote ?? '');
  const [showNote, setShowNote] = useState(false);
  const [error, setError] = useState('');
  const [isPending, startTransition] = useTransition();

  const allowed = ALLOWED_FROM[status] ?? [];

  function handle(newStatus: 'APPROVED' | 'REJECTED' | 'FLAGGED') {
    setError('');
    startTransition(async () => {
      const res = await setSubmissionStatus({
        submissionId,
        newStatus,
        adminNote: note.trim() ? note : undefined,
      });
      if (res.ok) {
        setStatus(newStatus);
        if (note.trim()) {
          setSavedNote(note.trim());
          setNote('');
          setShowNote(false);
        }
      } else {
        setError(
          res.error === 'INVALID_TRANSITION'
            ? "That status change isn't allowed from the current state."
            : 'Could not save. Please try again.',
        );
      }
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${STATUS_PILL[status]}`}>
          {status}
        </span>
        {allowed.map((s) => (
          <button
            key={s}
            type="button"
            disabled={isPending}
            onClick={() => handle(s)}
            className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors disabled:opacity-50 ${ACTION_STYLE[s]}`}
          >
            {ACTION_LABEL[s]}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowNote((v) => !v)}
          className="text-xs text-brand-stone hover:text-brand-ink underline"
        >
          {showNote ? 'Hide note' : 'Add note'}
        </button>
      </div>

      {savedNote && (
        <div className="text-xs text-brand-stone bg-brand-stone/5 border border-brand-stone/10 rounded px-2 py-1">
          <span className="font-medium text-brand-ink">Note:</span> {savedNote}
        </div>
      )}

      {showNote && (
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          rows={2}
          placeholder="Optional note for this decision"
          className="w-full text-xs rounded-md border border-brand-stone/20 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-saffron/40 focus:border-brand-saffron"
        />
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
