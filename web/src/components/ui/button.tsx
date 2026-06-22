'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './spinner';

type Variant = 'primary' | 'ghost' | 'danger' | 'soft';
type Size = 'md' | 'sm' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** When set, the button shows a spinner + this verb and is disabled (e.g. "Signing in…"). */
  loading?: boolean;
  loadingText?: string;
  icon?: ReactNode;
  block?: boolean;
}

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-[12.5px] rounded-md',
  md: 'h-10 px-4 text-[13px] rounded-md',
  lg: 'h-11 px-4 text-[13.5px] rounded-md',
};

/**
 * The app's button. `primary` = the accent gradient (§4.1); `ghost`/`soft` for secondary actions;
 * `danger` for Deny. Hover lifts brightness; loading swaps to spinner + verb. Colors are tokens, so
 * every theme is covered.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    loadingText,
    icon,
    block = false,
    className,
    children,
    disabled,
    style,
    ...rest
  },
  ref,
) {
  const base =
    'inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap transition select-none disabled:opacity-55 disabled:cursor-not-allowed hover:brightness-105';

  const variantCls: Record<Variant, string> = {
    primary: 'text-white border border-transparent',
    soft: 'text-accent border',
    ghost: 'text-text border bg-transparent hover:bg-surface-2',
    danger: 'text-red border bg-transparent hover:bg-[color-mix(in_srgb,var(--red)_8%,transparent)]',
  };

  const variantStyle: Record<Variant, React.CSSProperties> = {
    primary: {
      background: 'linear-gradient(145deg, var(--accent), var(--accent-2))',
      boxShadow: '0 5px 16px var(--accent-soft)',
    },
    soft: { background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' },
    ghost: { borderColor: 'var(--border-2)' },
    danger: { borderColor: 'color-mix(in srgb, var(--red) 40%, transparent)' },
  };

  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(base, SIZES[size], variantCls[variant], block && 'w-full', className)}
      style={{ ...variantStyle[variant], ...style }}
      {...rest}
    >
      {loading ? (
        <>
          <Spinner className="h-3.5 w-3.5" />
          {loadingText ?? children}
        </>
      ) : (
        <>
          {icon}
          {children}
        </>
      )}
    </button>
  );
});
