'use client';

import { useEffect } from 'react';

/**
 * localStorage-backed seed cache for the usage queries (`useOrgUsage` / `useCredentialUsage`) — lets a
 * fresh mount paint the LAST known snapshot instantly instead of a blank ring while the real fetch is
 * in flight. Versioned so a shape change can't hand old data to new code.
 */
const PREFIX = 'atlas:usage-cache:v1:';

export type CachedUsage<T> = { data: T; at: number };

/** Read a cached usage snapshot for `key`, or `null` on a miss, malformed entry, or SSR (no `window`). */
export function readUsageCache<T>(key: string): CachedUsage<T> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedUsage<T>>;
    if (typeof parsed.at !== 'number' || parsed.data == null) return null;
    return { data: parsed.data, at: parsed.at };
  } catch {
    return null;
  }
}

/** Persist a usage snapshot for `key`. Best-effort — a full/blocked localStorage silently no-ops. */
export function writeUsageCache<T>(key: string, data: T, at: number): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ data, at } satisfies CachedUsage<T>));
  } catch {
    /* best-effort — a full/blocked localStorage just means no seed next mount */
  }
}

/** Remove one cached usage snapshot, e.g. when a credential switch makes the org-level snapshot misleading. */
export function removeUsageCache(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* best-effort */
  }
}

/**
 * Mirror a query's latest value into the cache as it changes. Keyed on `dataUpdatedAt` (TanStack only
 * bumps it when the value actually changes), so this fires once per real update, never on an
 * undefined/error state.
 */
export function usePersistUsage<T>(key: string, data: T | undefined, dataUpdatedAt: number): void {
  useEffect(() => {
    if (data != null && dataUpdatedAt > 0) writeUsageCache(key, data, dataUpdatedAt);
  }, [key, data, dataUpdatedAt]);
}
