'use client';

import { useState, useTransition } from 'react';
import { submitContribution } from './actions';
import type { SubmitContributionInput } from './schema';

interface Props {
  slug: string;
  honoreeName: string;
  isBusiness: boolean;
}

const inputClass =
  'w-full rounded-lg border border-brand-stone/20 bg-white px-3 py-2 text-sm text-brand-ink placeholder:text-brand-stone/50 focus:outline-none focus:ring-2 focus:ring-brand-saffron/40 focus:border-brand-saffron';

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
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-brand-ink mb-1">
        {label}
        {required && <span aria-label="required" className="text-brand-saffron ml-1">*</span>}
      </label>
      {children}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

export function ContributorForm({ slug, honoreeName, isBusiness }: Props) {
  const [isPending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});
    setFormError('');

    const fd = new FormData(e.currentTarget);
    const input: SubmitContributionInput = {
      slug,
      contributorName: fd.get('contributorName') as string,
      relationship: fd.get('relationship') as string,
      email: fd.get('email') as string,
      textMessage: (fd.get('textMessage') as string) || '',
      funnyMemory: (fd.get('funnyMemory') as string) || '',
      advice: (fd.get('advice') as string) || '',
      professionalNote: (fd.get('professionalNote') as string) || '',
      isBusiness,
      consentGiven: fd.get('consentGiven') === 'on' ? true : (false as unknown as true),
    };

    startTransition(async () => {
      const result = await submitContribution(input);
      if (!result) return; // redirect() was called — navigation already happening
      if ('fieldErrors' in result && result.fieldErrors) {
        setFieldErrors(result.fieldErrors);
        // Focus first error field
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
    <form onSubmit={handleSubmit} noValidate className="space-y-5" aria-label="Contribution form">
      {/* Errors live region */}
      <div aria-live="polite" aria-atomic="true">
        {formError && (
          <div role="alert" className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            {formError}
          </div>
        )}
      </div>

      <Field id="contributorName" label="Your name" required error={fieldErrors.contributorName}>
        <input
          id="contributorName"
          name="contributorName"
          type="text"
          maxLength={120}
          required
          aria-required="true"
          aria-describedby={fieldErrors.contributorName ? 'contributorName-error' : undefined}
          className={inputClass}
        />
      </Field>

      <Field id="relationship" label={relationshipLabel} required error={fieldErrors.relationship}>
        <input
          id="relationship"
          name="relationship"
          type="text"
          maxLength={120}
          required
          aria-required="true"
          aria-describedby={fieldErrors.relationship ? 'relationship-error' : undefined}
          className={inputClass}
        />
      </Field>

      <Field id="email" label="Your email" required error={fieldErrors.email}>
        <input
          id="email"
          name="email"
          type="email"
          maxLength={254}
          required
          aria-required="true"
          aria-describedby={fieldErrors.email ? 'email-error' : undefined}
          className={inputClass}
          placeholder="you@example.com"
        />
      </Field>

      <Field id="textMessage" label={isBusiness ? 'Your message' : 'Your message'} error={fieldErrors.textMessage}>
        <textarea
          id="textMessage"
          name="textMessage"
          rows={4}
          maxLength={5000}
          aria-describedby={fieldErrors.textMessage ? 'textMessage-error' : undefined}
          className={textareaClass}
        />
      </Field>

      <Field id="funnyMemory" label={isBusiness ? 'A highlight / achievement' : 'A funny memory'} error={fieldErrors.funnyMemory}>
        <textarea
          id="funnyMemory"
          name="funnyMemory"
          rows={3}
          maxLength={5000}
          aria-describedby={fieldErrors.funnyMemory ? 'funnyMemory-error' : undefined}
          className={textareaClass}
        />
      </Field>

      <Field id="advice" label={isBusiness ? 'Advice or words for the road ahead' : 'Advice or a blessing'} error={fieldErrors.advice}>
        <textarea
          id="advice"
          name="advice"
          rows={3}
          maxLength={5000}
          aria-describedby={fieldErrors.advice ? 'advice-error' : undefined}
          className={textareaClass}
        />
      </Field>

      {isBusiness && (
        <Field id="professionalNote" label="A professional note" error={fieldErrors.professionalNote}>
          <textarea
            id="professionalNote"
            name="professionalNote"
            rows={3}
            maxLength={5000}
            aria-describedby={fieldErrors.professionalNote ? 'professionalNote-error' : undefined}
            className={textareaClass}
          />
        </Field>
      )}

      <div>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            id="consentGiven"
            name="consentGiven"
            type="checkbox"
            aria-required="true"
            aria-describedby={fieldErrors.consentGiven ? 'consentGiven-error' : undefined}
            className="mt-0.5 accent-brand-saffron h-4 w-4"
          />
          <span className="text-sm text-brand-ink">
            I consent to my submission being used in the tribute video.
          </span>
        </label>
        <FieldError id="consentGiven-error" message={fieldErrors.consentGiven} />
      </div>

      <button
        type="submit"
        disabled={isPending}
        className="w-full bg-brand-saffron text-white py-2.5 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {isPending ? 'Sending...' : 'Submit your contribution'}
      </button>
    </form>
  );
}
