'use client';

import { Command, CornerDownLeft } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * The ⌘↵ / Ctrl↵ key-cap hint shown inside a submit button — it advertises the ⌘/Ctrl+Enter shortcut
 * that fires the button's action. Two translucent key-caps (modifier + return) styled to read as physical
 * caps on the accent gradient: a `white/15` fill with a 1px inset highlight, no border. Platform is only
 * knowable in the browser, so it renders `null` until mounted (keeps SSR and the first client render in
 * sync), then shows ⌘ (lucide `Command`) on macOS or a "Ctrl" cap elsewhere, plus the return arrow.
 */
export function ShortcutHint() {
  const [isMac, setIsMac] = useState<boolean | null>(null);
  useEffect(() => {
    const platform =
      typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent : '';
    setIsMac(/mac|iphone|ipad|ipod/i.test(platform));
  }, []);
  if (isMac === null) return null;

  return (
    <span aria-hidden="true" className="inline-flex items-center gap-[3px]">
      <Cap>{isMac ? <Command size={11} strokeWidth={2.25} /> : 'Ctrl'}</Cap>
      <Cap>
        <CornerDownLeft size={11} strokeWidth={2.25} />
      </Cap>
    </span>
  );
}

function Cap({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-white/15 px-1 font-mono text-[12px] font-medium leading-none text-white/95"
      style={{
        boxShadow: 'inset 0 1px 0 0 rgba(255,255,255,0.28), inset 0 -1px 0 0 rgba(0,0,0,0.14)',
      }}
    >
      {children}
    </kbd>
  );
}
