'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useOrgs } from '@/lib/api/me';
import type { OrgSummary } from '@/lib/api/me';

/**
 * Holds the org-rail filter — `'all'` (the unified board across every org) or a single `orgId`. This is a
 * LABEL/FILTER, never a mode: the operator stays in one unified surface; selecting an org just narrows the
 * board + sidebar. The selection persists to localStorage and is validated against the session's orgs so a
 * stale id (left org) falls back to `'all'`.
 */
export type OrgFilter = 'all' | string;

const STORAGE_KEY = 'atlas-org-filter';

interface OrgFilterContextValue {
  filter: OrgFilter;
  setFilter: (f: OrgFilter) => void;
  /** Rail order: owned orgs first, then joined. */
  orgs: OrgSummary[];
  owned: OrgSummary[];
  joined: OrgSummary[];
  isLoading: boolean;
}

const OrgFilterContext = createContext<OrgFilterContextValue | null>(null);

export function OrgsProvider({ children }: { children: ReactNode }) {
  const { orgs, owned, joined, isLoading } = useOrgs();
  const [filter, setFilterState] = useState<OrgFilter>('all');

  // Restore the stored filter once orgs load; drop it if that org is gone.
  useEffect(() => {
    if (isLoading) return;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    if (stored && stored !== 'all' && !orgs.some((o) => o.id === stored)) {
      setFilterState('all');
    } else if (stored) {
      setFilterState(stored as OrgFilter);
    }
  }, [isLoading, orgs]);

  const setFilter = useCallback((f: OrgFilter) => {
    setFilterState(f);
    try {
      localStorage.setItem(STORAGE_KEY, f);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo(
    () => ({ filter, setFilter, orgs, owned, joined, isLoading }),
    [filter, setFilter, orgs, owned, joined, isLoading],
  );

  return <OrgFilterContext.Provider value={value}>{children}</OrgFilterContext.Provider>;
}

export function useOrgFilter(): OrgFilterContextValue {
  const ctx = useContext(OrgFilterContext);
  if (!ctx) throw new Error('useOrgFilter must be used within <OrgsProvider>');
  return ctx;
}
