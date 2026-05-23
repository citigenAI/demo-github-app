'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createEvent } from '../actions';
import { THEMES, MUSIC_MOODS } from '../schema';
import type { CreateEventInput } from '../schema';

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
}

function formatPrice(cents: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

function FieldError({ messages }: { messages?: string[] }) {
  if (!messages?.length) return null;
  return <p className="mt-1 text-xs text-red-600">{messages[0]}</p>;
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

export function CreateEventForm({ packages }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [globalError, setGlobalError] = useState('');

  const defaultPackageId = packages[0]?.id ?? '';
  const [selectedPackageId, setSelectedPackageId] = useState(defaultPackageId);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});
    setGlobalError('');

    const form = e.currentTarget;
    const fd = new FormData(form);

    const input: CreateEventInput = {
      honoreeName: fd.get('honoreeName') as string,
      occasionType: fd.get('occasionType') as CreateEventInput['occasionType'],
      eventDate: fd.get('eventDate') as string,
      submissionDeadline: fd.get('submissionDeadline') as string,
      deliveryDate: fd.get('deliveryDate') as string,
      theme: fd.get('theme') as CreateEventInput['theme'],
      musicMood: fd.get('musicMood') as CreateEventInput['musicMood'],
      expectedContributors: Number(fd.get('expectedContributors')),
      packageId: selectedPackageId,
    };

    startTransition(async () => {
      const result = await createEvent(input);
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
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Honoree */}
      <div>
        <Label htmlFor="honoreeName">Honoree name</Label>
        <input id="honoreeName" name="honoreeName" type="text" maxLength={120} className={inputClass} placeholder="e.g. Riya Sharma" />
        <FieldError messages={fieldErrors.honoreeName} />
      </div>

      {/* Occasion */}
      <div>
        <Label htmlFor="occasionType">Occasion</Label>
        <select id="occasionType" name="occasionType" className={inputClass}>
          <option value="">Choose an occasion</option>
          {OCCASION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <FieldError messages={fieldErrors.occasionType} />
      </div>

      {/* Event date */}
      <div>
        <Label htmlFor="eventDate">Event date</Label>
        <input id="eventDate" name="eventDate" type="date" className={inputClass} />
        <FieldError messages={fieldErrors.eventDate} />
      </div>

      {/* Submission deadline */}
      <div>
        <Label htmlFor="submissionDeadline">Submission deadline</Label>
        <input id="submissionDeadline" name="submissionDeadline" type="datetime-local" className={inputClass} />
        <p className="mt-1 text-xs text-brand-stone">Contributors must submit before this date and time.</p>
        <FieldError messages={fieldErrors.submissionDeadline} />
      </div>

      {/* Delivery date */}
      <div>
        <Label htmlFor="deliveryDate">Delivery date</Label>
        <input id="deliveryDate" name="deliveryDate" type="date" className={inputClass} />
        <FieldError messages={fieldErrors.deliveryDate} />
      </div>

      {/* Expected contributors */}
      <div>
        <Label htmlFor="expectedContributors">Expected contributors</Label>
        <input id="expectedContributors" name="expectedContributors" type="number" min={1} max={500} className={inputClass} placeholder="e.g. 20" />
        <FieldError messages={fieldErrors.expectedContributors} />
      </div>

      {/* Theme */}
      <div>
        <Label htmlFor="theme">Theme</Label>
        <select id="theme" name="theme" className={inputClass}>
          <option value="">Choose a theme</option>
          {THEMES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <FieldError messages={fieldErrors.theme} />
      </div>

      {/* Music mood */}
      <div>
        <Label htmlFor="musicMood">Music mood</Label>
        <select id="musicMood" name="musicMood" className={inputClass}>
          <option value="">Choose a mood</option>
          {MUSIC_MOODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
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
