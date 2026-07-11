"use client";

import { useEffect, useState } from "react";

/**
 * Shared px thresholds for the app shell's responsive tiers (wide/desktop/tablet/mobile). Single source
 * of truth — also imported by the Playwright viewport fixtures.
 */
export const BREAKPOINTS = { md: 768, lg: 1024, xl: 1280 } as const;

/** SSR-safe media query hook. Starts `false` on the server and first client paint (desktop-first), then
 * corrects itself once mounted — this keeps SSR markup and the first client render in sync. */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** The app shell's four responsive tiers, keyed to {@link BREAKPOINTS}. All four are `false` until the
 * mount effect in {@link useMediaQuery} resolves — the shell renders its desktop markup server-side. */
export function useBreakpoint() {
  const isMobile = useMediaQuery(`(max-width: ${BREAKPOINTS.md - 1}px)`);
  const isTablet = useMediaQuery(
    `(min-width: ${BREAKPOINTS.md}px) and (max-width: ${BREAKPOINTS.lg - 1}px)`,
  );
  const isDesktop = useMediaQuery(
    `(min-width: ${BREAKPOINTS.lg}px) and (max-width: ${BREAKPOINTS.xl - 1}px)`,
  );
  const isWide = useMediaQuery(`(min-width: ${BREAKPOINTS.xl}px)`);
  return { isMobile, isTablet, isDesktop, isWide };
}
