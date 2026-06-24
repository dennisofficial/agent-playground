'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { TopBar } from './top-bar';
import { OrgRail } from './org-rail';
import { Sidebar } from './sidebar';
import { CommandPalette } from './command-palette';

/**
 * The persistent app chrome (client) — owns the ⌘K palette state + keyboard handling and frames the
 * main region. `dialog` is the `@dialog` parallel slot (the create-thread modal); it overlays
 * everything when its intercepting route is active and renders nothing otherwise.
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
    <div className="flex h-dvh flex-col">
      <TopBar onOpenPalette={() => setPaletteOpen(true)} />
      <div className="flex min-h-0 flex-1">
        <OrgRail />
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
      </div>
      <CommandPalette open={paletteOpen} onClose={closePalette} />
      {dialog}
    </div>
  );
}
