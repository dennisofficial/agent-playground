'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { env } from '@/lib/env';
import { fetchWithRefresh } from './refresh';
import { qk } from './query-keys';
import type { ThreadKind } from './types';

/**
 * The unified cross-org inbox — every thread across ALL the operator's orgs (`GET /web/threads`), the
 * data behind the "All organizations" board and the org-grouped sidebar. The endpoint is login-gated and
 * inherently scoped to the caller's memberships; each row carries its org + repo so the UI can label it.
 *
 * NOTE (backend gap): the row has NO status / "needs you" signal, and only a coarse `origin` — so the UI
 * derives `kind` from `origin` and omits status dots. See the plan's "Data gaps" section.
 */

interface RawInboxThread {
  threadId: string;
  title: string | null;
  origin: string; // 'chat' | 'event' | 'control'
  createdAt: string;
  org: { id: string; slug?: string; name?: string };
  repo: { id: string; name?: string };
}

export interface InboxThread {
  id: string;
  title: string;
  kind: ThreadKind;
  createdAt: string;
  org: { id: string; slug: string; name: string };
  repo: { id: string; name: string };
}

/** Coarse kind from the thread origin. Only `event` is distinguishable; `chat`/`control` read as `feat`. */
function kindFromOrigin(origin: string): ThreadKind {
  return origin === 'event' ? 'event' : 'feat';
}

function normalize(r: RawInboxThread): InboxThread {
  return {
    id: r.threadId,
    title: r.title?.trim() || 'Untitled thread',
    kind: kindFromOrigin(r.origin),
    createdAt: r.createdAt,
    org: { id: r.org.id, slug: r.org.slug ?? r.org.id, name: r.org.name ?? 'Organization' },
    repo: { id: r.repo.id, name: r.repo.name ?? r.repo.id },
  };
}

async function fetchAllThreads(): Promise<InboxThread[]> {
  const res = await fetchWithRefresh(`${env.NEXT_PUBLIC_HTTP_URL}/web/threads`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`threads ${res.status}`);
  const rows = (await res.json()) as RawInboxThread[];
  return rows.map(normalize);
}

export function useAllThreads() {
  return useQuery({
    queryKey: qk.allThreads(),
    queryFn: fetchAllThreads,
    staleTime: 15_000,
  });
}

export interface OrgThreadGroup {
  orgId: string;
  orgName: string;
  threads: InboxThread[];
}

/**
 * Group threads by org, ordered to match a provided org order (the rail order: owned then joined). Orgs
 * absent from `orgOrder` fall to the end. Empty orgs are omitted unless `keepEmpty` lists them.
 */
export function groupThreadsByOrg(
  threads: InboxThread[],
  orgOrder: { id: string; name: string }[],
): OrgThreadGroup[] {
  const byId = new Map<string, OrgThreadGroup>();
  // Seed in the rail order so groups render owned-first even when a later org's thread is newer.
  for (const o of orgOrder) byId.set(o.id, { orgId: o.id, orgName: o.name, threads: [] });
  for (const t of threads) {
    let g = byId.get(t.org.id);
    if (!g) {
      g = { orgId: t.org.id, orgName: t.org.name, threads: [] };
      byId.set(t.org.id, g);
    }
    g.threads.push(t);
  }
  return [...byId.values()].filter((g) => g.threads.length > 0);
}

/** Convenience hook: the grouped inbox + flat list, filtered to one org or 'all'. */
export function useInbox(filter: 'all' | string, orgOrder: { id: string; name: string }[]) {
  const { data, isLoading, isError } = useAllThreads();
  const threads = useMemo(
    () => (data ?? []).filter((t) => filter === 'all' || t.org.id === filter),
    [data, filter],
  );
  const groups = useMemo(() => groupThreadsByOrg(threads, orgOrder), [threads, orgOrder]);
  return { threads, groups, isLoading, isError };
}
