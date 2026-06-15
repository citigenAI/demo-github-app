'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Camera, Mic, Video, X } from 'lucide-react';
import { submitContribution } from './actions';
import type { SubmitContributionInput, MediaItemRef } from './schema';

interface Props {
  slug: string;
  honoreeName: string;
  isBusiness: boolean;
}

type FileState = 'queued' | 'uploading' | 'uploaded' | 'error';

interface UploadEntry {
  localId: string;
  file: File;
  type: 'VIDEO' | 'VOICE' | 'PHOTO';
  state: FileState;
  errorMessage?: string;
  mediaId?: string;
  storageKey?: string;
}

const MAX_CONCURRENT = 3;

const ACCEPT_BY_TYPE: Record<'VIDEO' | 'VOICE' | 'PHOTO', string> = {
  VIDEO: 'video/mp4,video/quicktime,.mp4,.mov',
  VOICE: 'audio/mpeg,audio/mp4,audio/x-m4a,.mp3,.m4a',
  PHOTO: 'image/jpeg,image/png,.jpg,.jpeg,.png',
};

const SIZE_LIMIT_LABEL: Record<'VIDEO' | 'VOICE' | 'PHOTO', string> = {
  VIDEO: '500 MB',
  VOICE: '50 MB',
  PHOTO: '25 MB',
};

const inputClass =
  'w-full rounded-lg border border-brand-ink/12 bg-brand-ivory/50 px-4 py-3 text-sm text-brand-ink placeholder:text-brand-stone/50 focus:outline-none focus:ring-2 focus:ring-brand-deep-saffron/30 focus:border-brand-deep-saffron transition-colors';

const textareaClass = inputClass + ' resize-none';

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-red-600 flex items-center gap-1">
      <span aria-hidden>⚠</span> {message}
    </p>
  );
}

function Field({
  id, label, required, error, children,
}: {
  id: string; label: string; required?: boolean; error?: string; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs uppercase tracking-wider text-brand-stone font-medium">
        {label}
        {required && <span aria-label="required" className="text-brand-deep-saffron ml-1 normal-case tracking-normal">*</span>}
      </label>
      {children}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

function newLocalId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function newDraftId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ContributorForm({ slug, honoreeName, isBusiness }: Props) {
  const [isPending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const draftSubmissionIdRef = useRef<string>('');

  useEffect(() => {
    draftSubmissionIdRef.current = newDraftId();
  }, []);

  const inFlightCount = useMemo(
    () => entries.filter((e) => e.state === 'uploading').length,
    [entries],
  );

  // Pump the queue: start uploads for queued items up to MAX_CONCURRENT.
  useEffect(() => {
    const free = MAX_CONCURRENT - inFlightCount;
    if (free <= 0) return;
    const toStart = entries.filter((e) => e.state === 'queued').slice(0, free);
    if (toStart.length === 0) return;

    setEntries((prev) =>
      prev.map((e) =>
        toStart.find((t) => t.localId === e.localId) ? { ...e, state: 'uploading' } : e,
      ),
    );

    toStart.forEach((entry) => {
      void uploadOne(entry);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, inFlightCount]);

  async function uploadOne(entry: UploadEntry) {
    try {
      // Step 1: presign
      const presignRes = await fetch(`/api/contribute/${slug}/uploads/presign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileType: entry.type,
          mimeType: entry.file.type,
          originalName: entry.file.name,
          sizeBytes: entry.file.size,
          draftSubmissionId: draftSubmissionIdRef.current,
        }),
      });
      if (!presignRes.ok) {
        const data = await presignRes.json().catch(() => ({}));
        markEntry(entry.localId, {
          state: 'error',
          errorMessage:
            data.error === 'FILE_TOO_LARGE'
              ? `File exceeds the ${SIZE_LIMIT_LABEL[entry.type]} limit.`
              : data.error === 'UNSUPPORTED_MEDIA_TYPE'
                ? 'This file type is not supported.'
                : data.error === 'DEADLINE_PASSED'
                  ? 'Submissions have closed.'
                  : 'Could not start upload. Try again.',
        });
        return;
      }
      const { mediaId, storageKey, upload } = await presignRes.json();

      // Step 2: PUT bytes
      const putRes = await fetch(upload.url, {
        method: 'PUT',
        headers: upload.headers,
        body: entry.file,
      });
      if (!putRes.ok) {
        markEntry(entry.localId, { state: 'error', errorMessage: 'Upload failed. Try again.' });
        return;
      }
      markEntry(entry.localId, { state: 'uploaded', mediaId, storageKey });
    } catch {
      markEntry(entry.localId, { state: 'error', errorMessage: 'Upload failed. Try again.' });
    }
  }

  function markEntry(localId: string, patch: Partial<UploadEntry>) {
    setEntries((prev) => prev.map((e) => (e.localId === localId ? { ...e, ...patch } : e)));
  }

  function handlePick(type: 'VIDEO' | 'VOICE' | 'PHOTO', files: FileList | null) {
    if (!files) return;
    const additions: UploadEntry[] = [];
    for (const file of Array.from(files)) {
      additions.push({
        localId: newLocalId(),
        file,
        type,
        state: 'queued',
      });
    }
    setEntries((prev) => [...prev, ...additions]);
  }

  function removeEntry(localId: string) {
    setEntries((prev) => prev.filter((e) => e.localId !== localId));
  }

  function retryEntry(localId: string) {
    markEntry(localId, { state: 'queued', errorMessage: undefined });
  }

  const allFilesTerminal = entries.every((e) => e.state === 'uploaded' || e.state === 'error');
  const hasUploading = entries.some((e) => e.state === 'uploading' || e.state === 'queued');
  const submitDisabled = isPending || hasUploading;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});
    setFormError('');

    if (!allFilesTerminal) {
      setFormError('Wait for all files to finish uploading.');
      return;
    }

    const erroredItems = entries.filter((x) => x.state === 'error');
    if (erroredItems.length > 0) {
      setFormError('Remove or retry the files marked with errors before submitting.');
      return;
    }

    const fd = new FormData(e.currentTarget);
    const mediaItems: MediaItemRef[] = entries
      .filter((x) => x.state === 'uploaded' && x.mediaId && x.storageKey)
      .map((x) => ({
        mediaId: x.mediaId!,
        storageKey: x.storageKey!,
        type: x.type,
        originalName: x.file.name,
        sizeBytes: x.file.size,
        mimeType: x.file.type,
      }));

    const input: SubmitContributionInput = {
      slug,
      draftSubmissionId: draftSubmissionIdRef.current,
      contributorName: fd.get('contributorName') as string,
      relationship: fd.get('relationship') as string,
      email: fd.get('email') as string,
      textMessage: (fd.get('textMessage') as string) || '',
      funnyMemory: (fd.get('funnyMemory') as string) || '',
      advice: (fd.get('advice') as string) || '',
      professionalNote: (fd.get('professionalNote') as string) || '',
      isBusiness,
      consentGiven: fd.get('consentGiven') === 'on' ? true : (false as unknown as true),
      mediaItems,
    };

    startTransition(async () => {
      const result = await submitContribution(input);
      if (!result) return;
      if ('fieldErrors' in result && result.fieldErrors) {
        setFieldErrors(result.fieldErrors);
        const firstKey = Object.keys(result.fieldErrors)[0];
        if (firstKey) {
          const el = document.getElementById(firstKey);
          el?.focus();
        }
      }
      if ('formError' in result && result.formError) {
        setFormError(result.formError);
      }
    });
  }

  const relationshipLabel = isBusiness
    ? 'Your role / connection'
    : `Your relationship to ${honoreeName}`;

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-7" aria-label="Contribution form">
      <div aria-live="polite" aria-atomic="true">
        {formError && (
          <div role="alert" className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            {formError}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Field id="contributorName" label="Your name" required error={fieldErrors.contributorName}>
          <input id="contributorName" name="contributorName" type="text" maxLength={120} required className={inputClass} placeholder="Your full name" />
        </Field>

        <Field id="relationship" label={relationshipLabel} required error={fieldErrors.relationship}>
          <input id="relationship" name="relationship" type="text" maxLength={120} required className={inputClass} placeholder="e.g. Childhood friend, Cousin" />
        </Field>
      </div>

      <Field id="email" label="Your email" required error={fieldErrors.email}>
        <input id="email" name="email" type="email" maxLength={254} required className={inputClass} placeholder="name@example.com" />
      </Field>

      <Field id="textMessage" label="Your message" error={fieldErrors.textMessage}>
        <textarea id="textMessage" name="textMessage" rows={4} maxLength={5000} className={textareaClass} />
      </Field>

      <Field id="funnyMemory" label={isBusiness ? 'A highlight / achievement' : 'A funny memory'} error={fieldErrors.funnyMemory}>
        <textarea id="funnyMemory" name="funnyMemory" rows={3} maxLength={5000} className={textareaClass} />
      </Field>

      <Field id="advice" label={isBusiness ? 'Advice or words for the road ahead' : 'Advice or a blessing'} error={fieldErrors.advice}>
        <textarea id="advice" name="advice" rows={3} maxLength={5000} className={textareaClass} />
      </Field>

      {isBusiness && (
        <Field id="professionalNote" label="A professional note" error={fieldErrors.professionalNote}>
          <textarea id="professionalNote" name="professionalNote" rows={3} maxLength={5000} className={textareaClass} />
        </Field>
      )}

      {/* Media pickers */}
      <fieldset className="border border-brand-ink/12 rounded-xl p-5 space-y-4 bg-brand-ivory/30">
        <legend className="px-2 text-xs uppercase tracking-wider text-brand-stone font-medium">Add photos, video, or voice</legend>
        <p className="text-xs text-brand-stone/80 -mt-1">
          Optional. Files upload as you pick them. Max per file: photos {SIZE_LIMIT_LABEL.PHOTO}, voice {SIZE_LIMIT_LABEL.VOICE}, video {SIZE_LIMIT_LABEL.VIDEO}.
        </p>
        <div className="grid grid-cols-3 gap-3">
          {(['PHOTO', 'VOICE', 'VIDEO'] as const).map((t) => {
            const Icon = t === 'PHOTO' ? Camera : t === 'VOICE' ? Mic : Video;
            const label = t === 'PHOTO' ? 'Photos' : t === 'VOICE' ? 'Voice' : 'Video';
            return (
              <label
                key={t}
                className="group cursor-pointer flex flex-col items-center justify-center gap-2 py-5 border border-brand-ink/10 rounded-lg bg-white text-brand-ink hover:border-brand-deep-saffron hover:bg-brand-deep-saffron/5 transition-all"
              >
                <Icon
                  size={22}
                  strokeWidth={1.75}
                  className="text-brand-deep-saffron group-hover:scale-110 transition-transform"
                />
                <span className="text-xs font-medium text-brand-stone group-hover:text-brand-deep-saffron transition-colors">{label}</span>
                <input
                  type="file"
                  multiple
                  accept={ACCEPT_BY_TYPE[t]}
                  className="hidden"
                  onChange={(e) => {
                    handlePick(t, e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
            );
          })}
        </div>

        {entries.length > 0 && (
          <ul className="space-y-2 mt-2">
            {entries.map((e) => (
              <li
                key={e.localId}
                className="flex items-center justify-between gap-3 text-xs border border-brand-stone/10 rounded-lg px-3 py-2 bg-white"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-brand-ink">{e.file.name}</p>
                  <p className="text-brand-stone">
                    {e.type} · {humanSize(e.file.size)}
                  </p>
                  {e.errorMessage && <p className="text-red-600">{e.errorMessage}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                      e.state === 'uploaded'
                        ? 'bg-green-100 text-green-700'
                        : e.state === 'error'
                          ? 'bg-red-100 text-red-700'
                          : e.state === 'uploading'
                            ? 'bg-brand-saffron/10 text-brand-saffron'
                            : 'bg-brand-stone/10 text-brand-stone'
                    }`}
                  >
                    {e.state}
                  </span>
                  {e.state === 'error' && (
                    <button
                      type="button"
                      onClick={() => retryEntry(e.localId)}
                      className="text-brand-saffron underline"
                    >
                      Retry
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => removeEntry(e.localId)}
                    aria-label={`Remove ${e.file.name}`}
                    className="w-6 h-6 flex items-center justify-center rounded-full text-brand-stone hover:bg-red-100 hover:text-red-600 transition-colors"
                  >
                    <X size={14} strokeWidth={2} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <div className="pt-2">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            id="consentGiven"
            name="consentGiven"
            type="checkbox"
            aria-required="true"
            className="mt-0.5 accent-brand-deep-saffron h-5 w-5 rounded"
          />
          <span className="text-sm text-brand-stone leading-relaxed">
            I consent to my submission being used in the tribute video.
          </span>
        </label>
        <FieldError id="consentGiven-error" message={fieldErrors.consentGiven} />
      </div>

      <button
        type="submit"
        disabled={submitDisabled}
        className="w-full bg-brand-deep-saffron hover:opacity-90 text-white py-3.5 rounded-full text-sm font-medium transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5 disabled:opacity-50 disabled:translate-y-0 disabled:shadow-none"
      >
        {isPending ? 'Sending...' : hasUploading ? 'Waiting for files...' : 'Submit your contribution'}
      </button>
    </form>
  );
}
