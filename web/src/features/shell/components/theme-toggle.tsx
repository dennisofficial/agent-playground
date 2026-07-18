'use client';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

const OPTIONS = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const active = mounted ? theme : undefined;
  return (
    <div className="px-3 py-1.5">
      <p className="mb-1.5 text-[10px] uppercase tracking-wider text-faint">Theme</p>
      <div
        role="radiogroup"
        aria-label="Theme"
        className="flex gap-0.5 rounded-md border border-border bg-surface-2 p-0.5"
      >
        {OPTIONS.map(({ value, label, Icon }) => {
          const selected = active === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setTheme(value)}
              className={`flex flex-1 items-center justify-center gap-1 rounded-[4px] px-1.5 py-1 text-[11px] transition ${
                selected ? 'bg-panel text-text shadow-sm' : 'text-dim hover:text-text'
              }`}
            >
              <Icon size={12} className="shrink-0" /> {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
