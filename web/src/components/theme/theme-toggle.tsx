'use client';

import { cn } from '@/lib/cn';
import { THEMES, THEME_LABELS, useTheme, type Theme } from './theme-provider';

/** Segmented Day / Terminal / Warm control (handoff §4.2 top bar). */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border border-border bg-surface-2 p-0.5',
        className,
      )}
      role="radiogroup"
      aria-label="Theme"
    >
      {THEMES.map((t: Theme) => {
        const active = t === theme;
        return (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(t)}
            className={cn(
              'rounded-[5px] px-2.5 py-1 text-[11px] font-medium transition',
              active ? 'text-text' : 'text-faint hover:text-dim',
            )}
            style={active ? { background: 'var(--surface)', boxShadow: 'var(--shadow-card)' } : undefined}
          >
            {THEME_LABELS[t]}
          </button>
        );
      })}
    </div>
  );
}
