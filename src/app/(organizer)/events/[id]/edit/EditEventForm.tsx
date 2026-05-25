'use client';

import { useState, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { updateEvent } from '../../actions';
import { THEMES, MUSIC_MOODS, UpdateEventSchema, THEME_DESCRIPTIONS, MOOD_DESCRIPTIONS } from '../../schema';

interface EventValues {
  id: string;
  name: string;
  eventDate: string; // YYYY-MM-DD
  deliveryDate: string; // YYYY-MM-DD
  submissionDeadline: string; // ISO timestamp
  theme: string;
  musicMood: string;
}

const inputClass =
  'w-full rounded-lg border border-brand-stone/20 bg-white px-3 py-2 text-sm text-brand-ink placeholder:text-brand-stone/50 focus:outline-none focus:ring-2 focus:ring-brand-saffron/40 focus:border-brand-saffron';

function FieldError({ messages }: { messages?: string[] }) {
  if (!messages?.length) return null;
  return (
    <p role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs text-red-600">
      <svg className="mt-px h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
          clipRule="evenodd"
        />
      </svg>
      <span>{messages[0]}</span>
    </p>
  );
}

export function EditEventForm({ event }: { event: EventValues }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [globalError, setGlobalError] = useState('');

  const [eventDate, setEventDate] = useState(event.eventDate);
  const [deliveryDate, setDeliveryDate] = useState(event.deliveryDate);
  const [submissionDeadline, setSubmissionDeadline] = useState('');
  const [theme, setTheme] = useState(event.theme);
  const [musicMood, setMusicMood] = useState(event.musicMood);

  // Computed after mount to avoid SSR/hydration timezone mismatch; also converts the
  // stored UTC deadline back to a local datetime-local value for the picker.
  const [today, setToday] = useState('');
  const [nowLocal, setNowLocal] = useState('');
  useEffect(() => {
    const toLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    const now = toLocal(new Date());
    setToday(now.toISOString().slice(0, 10));
    setNowLocal(now.toISOString().slice(0, 16));
    setSubmissionDeadline(toLocal(new Date(event.submissionDeadline)).toISOString().slice(0, 16));
  }, [event.submissionDeadline]);

  const deadlineDay = submissionDeadline ? submissionDeadline.slice(0, 10) : today;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});
    setGlobalError('');

    const input = { eventDate, submissionDeadline, deliveryDate, theme, musicMood };
    const parsed = UpdateEventSchema.safeParse(input);
    if (!parsed.success) {
      const fields: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0]);
        (fields[key] ??= []).push(issue.message);
      }
      setFieldErrors(fields);
      const firstEl = e.currentTarget.elements.namedItem(Object.keys(fields)[0] ?? '');
      if (firstEl instanceof HTMLElement) firstEl.focus();
      return;
    }

    startTransition(async () => {
      const result = await updateEvent(event.id, parsed.data);
      if ('error' in result) {
        if ('fields' in result && result.fields) setFieldErrors(result.fields);
        else setGlobalError(result.error);
        return;
      }
      router.push(`/events/${event.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      <div className="rounded-lg bg-brand-stone/5 px-3 py-2 text-xs text-brand-stone">
        Editing <span className="font-medium text-brand-ink">{event.name}</span>. The event name, honoree,
        and occasion can&apos;t be changed.
      </div>

      {/* Event date */}
      <div>
        <label htmlFor="eventDate" className="block text-sm font-medium text-brand-ink mb-1">Event date</label>
        <input
          id="eventDate"
          name="eventDate"
          type="date"
          required
          min={today || undefined}
          value={eventDate}
          onChange={(e) => setEventDate(e.target.value)}
          className={inputClass}
        />
        <p className="mt-1 text-xs text-brand-stone">The submission deadline and delivery date must be on or before this date.</p>
        <FieldError messages={fieldErrors.eventDate} />
      </div>

      {/* Submission deadline */}
      <div>
        <label htmlFor="submissionDeadline" className="block text-sm font-medium text-brand-ink mb-1">Submission deadline</label>
        <input
          id="submissionDeadline"
          name="submissionDeadline"
          type="datetime-local"
          required
          min={nowLocal || undefined}
          max={eventDate ? `${eventDate}T23:59` : undefined}
          value={submissionDeadline}
          onChange={(e) => setSubmissionDeadline(e.target.value)}
          className={inputClass}
        />
        <FieldError messages={fieldErrors.submissionDeadline} />
      </div>

      {/* Delivery date */}
      <div>
        <label htmlFor="deliveryDate" className="block text-sm font-medium text-brand-ink mb-1">Delivery date</label>
        <input
          id="deliveryDate"
          name="deliveryDate"
          type="date"
          required
          min={deadlineDay || undefined}
          max={eventDate || undefined}
          value={deliveryDate}
          onChange={(e) => setDeliveryDate(e.target.value)}
          className={inputClass}
        />
        <FieldError messages={fieldErrors.deliveryDate} />
      </div>

      {/* Theme */}
      <div>
        <p className="text-sm font-medium text-brand-ink mb-2">Theme</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {THEMES.map((t) => (
            <label
              key={t}
              className={`flex items-start gap-2.5 border rounded-xl p-3 cursor-pointer transition-colors ${
                theme === t ? 'border-brand-saffron bg-brand-saffron/5' : 'border-brand-stone/20 bg-white hover:border-brand-stone/40'
              }`}
            >
              <input type="radio" name="theme" value={t} checked={theme === t} onChange={() => setTheme(t)} className="mt-0.5 accent-brand-saffron" />
              <span>
                <span className="block text-sm font-medium text-brand-ink">{t}</span>
                <span className="block text-xs text-brand-stone mt-0.5">{THEME_DESCRIPTIONS[t]}</span>
              </span>
            </label>
          ))}
        </div>
        <FieldError messages={fieldErrors.theme} />
      </div>

      {/* Music mood */}
      <div>
        <p className="text-sm font-medium text-brand-ink mb-2">Music mood</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {MUSIC_MOODS.map((m) => (
            <label
              key={m}
              className={`flex items-start gap-2.5 border rounded-xl p-3 cursor-pointer transition-colors ${
                musicMood === m ? 'border-brand-saffron bg-brand-saffron/5' : 'border-brand-stone/20 bg-white hover:border-brand-stone/40'
              }`}
            >
              <input type="radio" name="musicMood" value={m} checked={musicMood === m} onChange={() => setMusicMood(m)} className="mt-0.5 accent-brand-saffron" />
              <span>
                <span className="block text-sm font-medium text-brand-ink">{m}</span>
                <span className="block text-xs text-brand-stone mt-0.5">{MOOD_DESCRIPTIONS[m]}</span>
              </span>
            </label>
          ))}
        </div>
        <FieldError messages={fieldErrors.musicMood} />
      </div>

      {globalError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">{globalError}</p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="bg-brand-saffron text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={() => router.push(`/events/${event.id}`)}
          className="text-sm text-brand-stone hover:text-brand-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
