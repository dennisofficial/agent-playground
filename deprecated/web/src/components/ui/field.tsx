'use client';

import { cn } from '@/lib/cn';
import { Eye, EyeOff } from 'lucide-react';
import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';

export const inputCls =
  'w-full h-11 rounded-md border bg-surface px-3 text-[13px] text-text placeholder:text-faint outline-none transition focus:border-accent focus:ring-2 focus:ring-(--accent-soft) data-[err=true]:border-red data-[err=true]:focus:ring-[color-mix(in_srgb,var(--red)_30%,transparent)]';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | null;
  /** Optional element rendered on the right of the label row (e.g. a "Forgot?" link). */
  labelAside?: ReactNode;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, labelAside, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={fieldId} className="text-[12px] font-medium text-dim">
          {label}
        </label>
        {labelAside}
      </div>
      <input
        ref={ref}
        id={fieldId}
        data-err={error ? 'true' : 'false'}
        className={cn(inputCls, className)}
        {...rest}
      />
      {error ? <p className="text-[11.5px] text-red">{error}</p> : null}
    </div>
  );
});

interface PasswordFieldProps extends Omit<FieldProps, 'type'> {}

export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
  function PasswordField({ label, error, labelAside, className, id, ...rest }, ref) {
    const autoId = useId();
    const fieldId = id ?? autoId;
    const [show, setShow] = useState(false);
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor={fieldId} className="text-[12px] font-medium text-dim">
            {label}
          </label>
          {labelAside}
        </div>
        <div className="relative">
          <input
            ref={ref}
            id={fieldId}
            type={show ? 'text' : 'password'}
            data-err={error ? 'true' : 'false'}
            className={cn(inputCls, 'pr-16', className)}
            {...rest}
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-faint hover:text-dim"
            tabIndex={-1}
            aria-label={show ? 'Hide password' : 'Show password'}
          >
            {show ? <EyeOff size={12} /> : <Eye size={12} />}
            {show ? 'hide' : 'show'}
          </button>
        </div>
        {error ? <p className="text-[11.5px] text-red">{error}</p> : null}
      </div>
    );
  },
);

export function StrengthMeter({ password }: { password: string }) {
  const score = strength(password);
  const meta = [
    { label: '', color: 'var(--border-2)' },
    { label: 'Weak', color: 'var(--red)' },
    { label: 'Fair', color: 'var(--accent)' },
    { label: 'Good', color: 'var(--blue)' },
    { label: 'Strong', color: 'var(--green)' },
  ][score];

  return (
    <div className="flex items-center gap-2">
      <div className="flex flex-1 gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="h-1 flex-1 rounded-full transition-colors"
            style={{ background: i < score ? meta.color : 'var(--border-2)' }}
          />
        ))}
      </div>
      <span className="w-12 text-right font-mono text-[10px]" style={{ color: meta.color }}>
        {meta.label}
      </span>
    </div>
  );
}

function strength(password: string): number {
  if (!password) return 0;
  let score = 0;
  if (password.length >= 8) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  return Math.min(4, Math.max(1, score));
}
