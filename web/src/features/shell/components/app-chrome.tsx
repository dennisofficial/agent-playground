'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Sidebar } from './sidebar';
import { CommandPalette } from './command-palette';

/**
 * The persistent app chrome (client). The design collapses the old top-bar + org-rail + sidebar into a
 * single sidebar that is the home for navigation (org → repo → thread); the main region is the dashboard
 * or a thread workspace. This owns the ⌘K palette state + keyboard handling. `dialog` is the `@dialog`
 * parallel slot (the create-thread modal); it overlays everything when its intercepting route is active.
 */
export function AppChrome({ children, dialog }: { children: ReactNode; dialog: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-dvh min-h-0">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
      <CommandPalette open={paletteOpen} onClose={closePalette} />
      {dialog}
    </div>
  );
}
