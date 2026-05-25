'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createEvent } from '../actions';
import { THEMES, MUSIC_MOODS, CreateEventSchema, THEME_DESCRIPTIONS, MOOD_DESCRIPTIONS } from '../schema';

const OCCASION_OPTIONS = [
  { value: 'GRADUATION', label: 'Graduation' },
  { value: 'BIRTHDAY', label: 'Birthday' },
  { value: 'WEDDING', label: 'Wedding' },
  { value: 'ANNIVERSARY', label: 'Anniversary' },
  { value: 'RETIREMENT', label: 'Retirement' },
  { value: 'BUSINESS_EVENT', label: 'Business Event' },
] as const;

interface Package {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  features: string[];
  deliverySlaDays: number;
  includedRevisions: number;
}

interface Props {
  packages: Package[];
  defaultOrganizerName: string;
}

function formatPrice(cents: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

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

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-brand-ink mb-1">
      {children}
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border border-brand-stone/20 bg-white px-3 py-2 text-sm text-brand-ink placeholder:text-brand-stone/50 focus:outline-none focus:ring-2 focus:ring-brand-saffron/40 focus:border-brand-saffron';

export function CreateEventForm({ packages, defaultOrganizerName }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [globalError, setGlobalError] = useState('');

  const defaultPackageId = packages[0]?.id ?? '';
  const [selectedPackageId, setSelectedPackageId] = useState(defaultPackageId);
  const [selectedTheme, setSelectedTheme] = useState('');
  const [selectedMusicMood, setSelectedMusicMood] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [submissionDeadline, setSubmissionDeadline] = useState('');

  // "today"/"now" are computed after mount to avoid an SSR/hydration timezone mismatch.
  const [today, setToday] = useState('');
  const [nowLocal, setNowLocal] = useState('');
  useEffect(() => {
    const d = new Date();
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    setToday(local.toISOString().slice(0, 10));
    setNowLocal(local.toISOString().slice(0, 16));
  }, []);

  // Pickers only allow today → event date, so out-of-range dates can't be selected.
  const deadlineDay = submissionDeadline ? submissionDeadline.slice(0, 10) : today;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});
    setGlobalError('');

    const form = e.currentTarget;
    const fd = new FormData(form);

    const input = {
      honoreeName: (fd.get('honoreeName') as string) ?? '',
      organizerName: (fd.get('organizerName') as string) ?? '',
      name: (fd.get('name') as string) ?? '',
      occasionType: (fd.get('occasionType') as string) ?? '',
      eventDate: (fd.get('eventDate') as string) ?? '',
      submissionDeadline: (fd.get('submissionDeadline') as string) ?? '',
      deliveryDate: (fd.get('deliveryDate') as string) ?? '',
      theme: (fd.get('theme') as string) ?? '',
      musicMood: (fd.get('musicMood') as string) ?? '',
      expectedContributors: fd.get('expectedContributors') ?? '',
      packageId: selectedPackageId,
    };

    // Validate with the SAME schema the server enforces, and show branded inline
    // errors (native validation bubbles can't be CSS-styled). Server re-validates.
    const parsed = CreateEventSchema.safeParse(input);
    if (!parsed.success) {
      const fields: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0]);
        (fields[key] ??= []).push(issue.message);
      }
      setFieldErrors(fields);
      const firstKey = Object.keys(fields)[0];
      const firstEl = firstKey ? form.elements.namedItem(firstKey) : null;
      if (firstEl instanceof HTMLElement) firstEl.focus();
      return;
    }

    startTransition(async () => {
      const result = await createEvent(parsed.data);
      if ('error' in result) {
        if ('fields' in result && result.fields) {
          setFieldErrors(result.fields);
        } else {
          setGlobalError(result.error);
        }
        return;
      }
      router.push(`/events/${result.id}?created=1`);
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      {/* Organizer name */}
      <div>
        <Label htmlFor="organizerName">Your name</Label>
        <input id="organizerName" name="organizerName" type="text" required defaultValue={defaultOrganizerName} maxLength={120} className={inputClass} placeholder="e.g. Priya (sister)" />
        <p className="mt-1 text-xs text-brand-stone">Shown to contributors as &quot;Organized by …&quot;.</p>
        <FieldError messages={fieldErrors.organizerName} />
      </div>

      {/* Honoree */}
      <div>
        <Label htmlFor="honoreeName">Honoree name</Label>
        <input id="honoreeName" name="honoreeName" type="text" required maxLength={120} className={inputClass} placeholder="e.g. Riya Sharma" />
        <p className="mt-1 text-xs text-brand-stone">Who the tribute is for. For a couple, enter both names (e.g. &quot;Anusha and Manoj&quot;).</p>
        <FieldError messages={fieldErrors.honoreeName} />
      </div>

      {/* Occasion */}
      <div>
        <Label htmlFor="occasionType">Occasion</Label>
        <select id="occasionType" name="occasionType" required className={inputClass}>
          <option value="">Choose an occasion</option>
          {OCCASION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <FieldError messages={fieldErrors.occasionType} />
      </div>

      {/* Event name (optional) */}
      <div>
        <Label htmlFor="name">Event name <span className="font-normal text-brand-stone">(optional)</span></Label>
        <input id="name" name="name" type="text" maxLength={120} className={inputClass} placeholder="e.g. Manu's 16th Birthday" />
        <p className="mt-1 text-xs text-brand-stone">Your own label for this event. Leave blank to use &quot;[Honoree]&apos;s [Occasion] tribute&quot;.</p>
        <FieldError messages={fieldErrors.name} />
      </div>

      {/* Event date */}
      <div>
        <Label htmlFor="eventDate">Event date</Label>
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
        <p className="mt-1 text-xs text-brand-stone">Pick this first — the submission deadline and delivery date are limited to on or before it.</p>
        <FieldError messages={fieldErrors.eventDate} />
      </div>

      {/* Submission deadline */}
      <div>
        <Label htmlFor="submissionDeadline">Submission deadline</Label>
        <input
          id="submissionDeadline"
          name="submissionDeadline"
          type="datetime-local"
          required
          min={nowLocal || undefined}
          max={eventDate ? `${eventDate}T23:59` : undefined}
          value={submissionDeadline}
          onChange={(e) => setSubmissionDeadline(e.target.value)}
          disabled={!eventDate}
          className={inputClass}
        />
        <p className="mt-1 text-xs text-brand-stone">
          {eventDate ? 'Contributors must submit before this date and time.' : 'Pick the event date first.'}
        </p>
        <FieldError messages={fieldErrors.submissionDeadline} />
      </div>

      {/* Delivery date */}
      <div>
        <Label htmlFor="deliveryDate">Delivery date</Label>
        <input
          id="deliveryDate"
          name="deliveryDate"
          type="date"
          required
          min={deadlineDay || undefined}
          max={eventDate || undefined}
          disabled={!eventDate}
          className={inputClass}
        />
        <p className="mt-1 text-xs text-brand-stone">
          {eventDate ? 'On or after the submission deadline, on or before the event date.' : 'Pick the event date first.'}
        </p>
        <FieldError messages={fieldErrors.deliveryDate} />
      </div>

      {/* Expected contributors */}
      <div>
        <Label htmlFor="expectedContributors">Expected contributors</Label>
        <input id="expectedContributors" name="expectedContributors" type="number" required min={1} max={500} className={inputClass} placeholder="e.g. 20" />
        <FieldError messages={fieldErrors.expectedContributors} />
      </div>

      {/* Theme */}
      <div>
        <p className="text-sm font-medium text-brand-ink mb-1">Theme</p>
        <p className="text-xs text-brand-stone mb-2">The visual style of the finished video.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {THEMES.map((t) => (
            <label
              key={t}
              className={`flex items-start gap-2.5 border rounded-xl p-3 cursor-pointer transition-colors ${
                selectedTheme === t
                  ? 'border-brand-saffron bg-brand-saffron/5'
                  : 'border-brand-stone/20 bg-white hover:border-brand-stone/40'
              }`}
            >
              <input
                type="radio"
                name="theme"
                value={t}
                checked={selectedTheme === t}
                onChange={() => setSelectedTheme(t)}
                className="mt-0.5 accent-brand-saffron"
              />
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
        <p className="text-sm font-medium text-brand-ink mb-1">Music mood</p>
        <p className="text-xs text-brand-stone mb-2">The feeling of the background music.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {MUSIC_MOODS.map((m) => (
            <label
              key={m}
              className={`flex items-start gap-2.5 border rounded-xl p-3 cursor-pointer transition-colors ${
                selectedMusicMood === m
                  ? 'border-brand-saffron bg-brand-saffron/5'
                  : 'border-brand-stone/20 bg-white hover:border-brand-stone/40'
              }`}
            >
              <input
                type="radio"
                name="musicMood"
                value={m}
                checked={selectedMusicMood === m}
                onChange={() => setSelectedMusicMood(m)}
                className="mt-0.5 accent-brand-saffron"
              />
              <span>
                <span className="block text-sm font-medium text-brand-ink">{m}</span>
                <span className="block text-xs text-brand-stone mt-0.5">{MOOD_DESCRIPTIONS[m]}</span>
              </span>
            </label>
          ))}
        </div>
        <FieldError messages={fieldErrors.musicMood} />
      </div>

      {/* Package selection */}
      <div>
        <p className="text-sm font-medium text-brand-ink mb-2">Package</p>
        <div className="space-y-3">
          {packages.map((pkg) => (
            <label
              key={pkg.id}
              className={`flex items-start gap-3 border rounded-xl p-4 cursor-pointer transition-colors ${
                selectedPackageId === pkg.id
                  ? 'border-brand-saffron bg-brand-saffron/5'
                  : 'border-brand-stone/20 bg-white hover:border-brand-stone/40'
              }`}
            >
              <input
                type="radio"
                name="packageId"
                value={pkg.id}
                checked={selectedPackageId === pkg.id}
                onChange={() => setSelectedPackageId(pkg.id)}
                className="mt-0.5 accent-brand-saffron"
              />
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-brand-ink">{pkg.name}</span>
                  <span className="text-sm font-semibold text-brand-saffron">
                    {formatPrice(pkg.priceCents, pkg.currency)}
                  </span>
                </div>
                <ul className="mt-1.5 space-y-0.5">
                  {pkg.features.map((f) => (
                    <li key={f} className="text-xs text-brand-stone flex items-center gap-1.5">
                      <span className="text-brand-saffron">✓</span>
                      {f.replace(/_/g, ' ')}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-brand-stone mt-1">
                  Delivery in {pkg.deliverySlaDays} days
                  {pkg.includedRevisions > 0 ? ` · ${pkg.includedRevisions} revision${pkg.includedRevisions > 1 ? 's' : ''} included` : ''}
                </p>
              </div>
            </label>
          ))}
        </div>
        <FieldError messages={fieldErrors.packageId} />
      </div>

      {globalError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          {globalError}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full bg-brand-saffron text-white py-2.5 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {isPending ? 'Creating...' : 'Create event'}
      </button>
    </form>
  );
}
