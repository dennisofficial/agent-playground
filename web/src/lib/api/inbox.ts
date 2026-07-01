'use client';

import { useQuery } from '@tanstack/react-query';
import { env } from '@/lib/env';
import { fetchWithRefresh } from './refresh';
import { qk } from './query-keys';
import { toJobStatus } from './status';
import type { WireJobStatus, JobStatus, JobKind } from './types';

/**
 * The unified cross-org inbox — every thread across ALL the operator's orgs (`GET /web/threads`), the
 * data behind the "All organizations" board and the org-grouped sidebar. The endpoint is login-gated and
 * inherently scoped to the caller's memberships; each row carries its org + repo so the UI can label it.
 *
 * The row carries a server-owned `status` + `needsYou` ("needs you" = the AI isn't actively working and
 * the thread isn't terminal — see the backend `deriveNeedsYou`). These power the status pie + the alert
 * dot for EVERY thread, not just the open one; a realtime feed keeps them live (see `useAllThreadsRealtime`).
 */

export interface RawInboxThread {
  threadId: string;
  title: string | null;
  origin: string; // 'chat' | 'event' | 'control'
  /** Raw backend thread status ('open' | 'planning' | … | 'cancelled'). */
  status: string;
  /** Server-derived: the thread is awaiting the operator (AI idle, not terminal). */
  needsYou: boolean;
  createdAt: string;
  org: { id: string; slug?: string; name?: string };
  repo: { id: string; name?: string };
}

export interface InboxThread {
  id: string;
  title: string;
  kind: JobKind;
  /** UI status (mapped from the backend status) — drives the status pie. */
  status: JobStatus;
  /** The alert dot: this thread is waiting on you. */
  needsYou: boolean;
  createdAt: string;
  org: { id: string; slug: string; name: string };
  repo: { id: string; name: string };
}

/** Coarse kind from the thread origin. Only `event` is distinguishable; `chat`/`control` read as `feat`. */
function kindFromOrigin(origin: string): JobKind {
  return origin === 'event' ? 'event' : 'feat';
}

/** Backend status (incl. `open`, which `toJobStatus` doesn't cover) → UI status for the pie. */
export function uiStatus(backend: string, origin: string): JobStatus {
  if (backend === 'open') return origin === 'event' ? 'triaging' : 'planning';
  return toJobStatus(backend as WireJobStatus);
}

export function normalize(r: RawInboxThread): InboxThread {
  return {
    id: r.threadId,
    title: r.title?.trim() || 'Untitled thread',
    kind: kindFromOrigin(r.origin),
    status: uiStatus(r.status, r.origin),
    needsYou: r.needsYou,
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

/** A repo subgroup: the in-flight threads on one repo. */
export interface RepoThreadGroup {
  repoId: string;
  repoName: string;
  threads: InboxThread[];
}

/** An org with its repos that have threads (the sidebar's org → repo → thread tree). */
export interface OrgRepoGroup {
  orgId: string;
  orgName: string;
  repos: RepoThreadGroup[];
}

/**
 * Group threads into an org → repo → thread tree, ordered to match `orgOrder` (owned then joined) so
 * owned orgs sort first even when a later org's thread is newer; repos sort by first-seen. Only orgs and
 * repos that actually have threads are returned — the sidebar overlays empty-org cards from `useOrgs()`.
 */
export function groupThreadsByOrgAndRepo(
  threads: InboxThread[],
  orgOrder: { id: string; name: string }[],
): OrgRepoGroup[] {
  interface OrgAcc {
    orgId: string;
    orgName: string;
    repos: Map<string, RepoThreadGroup>;
  }
  const byOrg = new Map<string, OrgAcc>();
  const ensureOrg = (id: string, name: string): OrgAcc => {
    let o = byOrg.get(id);
    if (!o) {
      o = { orgId: id, orgName: name, repos: new Map() };
      byOrg.set(id, o);
    }
    return o;
  };
  // Seed in the rail order so orgs render owned-first regardless of thread recency.
  for (const o of orgOrder) ensureOrg(o.id, o.name);
  for (const t of threads) {
    const o = ensureOrg(t.org.id, t.org.name);
    let r = o.repos.get(t.repo.id);
    if (!r) {
      r = { repoId: t.repo.id, repoName: t.repo.name, threads: [] };
      o.repos.set(t.repo.id, r);
    }
    r.threads.push(t);
  }
  return [...byOrg.values()]
    .map((o) => ({ orgId: o.orgId, orgName: o.orgName, repos: [...o.repos.values()] }))
    .filter((o) => o.repos.length > 0);
}
