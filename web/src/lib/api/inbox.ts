'use client';

import { useGetJobsQuery } from '@/redux/query/api/jobs.api';
import { useGetAllReposQuery } from '@/redux/query/api/repo.api';
import { EJobActivity, EJobKind, EJobStatus, JobHalt, JobListItem } from '@workspace/shared';
import { useMemo } from 'react';
import { adaptQuery, type QueryResultLike } from './_stub';
import { useOrgs } from './me';
import type { CiCounts, CiStatus, InboxPr, JobBlocker, JobProvenance } from './types';

/**
 * The unified cross-org inbox — every thread across ALL the operator's orgs (`GET /web/jobs`), the
 * data behind the "All organizations" board and the org-grouped sidebar. The endpoint is login-gated and
 * inherently scoped to the caller's memberships; each row carries its org + repo so the UI can label it.
 *
 * The row carries a server-owned `status` + `needsYou` ("needs you" = the AI isn't actively working and
 * the thread isn't terminal — see the backend `deriveNeedsYou`). These power the status pie + the alert
 * dot for EVERY thread, not just the open one; a realtime feed keeps them live (see `useAllJobsRealtime`).
 */

export interface InboxThread {
  id: string;
  title: string;
  kind: EJobKind;
  /** UI status (mapped from the backend status) — drives the status pie. */
  status: EJobStatus;
  /** Raw backend status ('open' | 'planning' | … | 'cancelled') — the `sectionFirstEntered` anchor-map
   *  key. Distinct from `status`, which is the UI-mapped status used for grouping. */
  rawStatus: EJobStatus;
  /** jobs.section_first_entered — backend JobStatus -> ISO ts of first entry into that status. Drives
   *  the sidebar's per-section anchor sort (newest arrival on top). */
  sectionFirstEntered?: Partial<Record<EJobStatus, string>> | null;
  /** Backend activity axis, retained so realtime and REST cache rows match the wire contract. */
  activity: EJobActivity;
  /** The alert dot: this thread is waiting on you. */
  needsYou: boolean;
  /** A turn-stopping error is outstanding — the sidebar shows the failed ✕ glyph over the status pie. */
  halted: boolean;
  createdAt: string;
  /** The observed PR (null until one exists) — when present the sidebar shows a PR-status glyph
   *  instead of the build `status` pie. */
  pr: InboxPr | null;
  /** Aggregate CI outcome for the PR head — drives the sidebar CI dot. null = no checks reported. */
  ci: CiStatus | null;
  /** Per-category CI check counts — parallel to `ci`; null when no checks reported. */
  ciCounts: CiCounts | null;
  /** Sidebar port badge tri-state: a live service exposed via a public preview URL, a live but
   *  unexposed service, or null when nothing is running. Exposed-wins is resolved server-side. */
  portState: 'exposed' | 'internal' | null;
  /** Count of build/direct_build thread groups whose builder work has finished. null = not applicable. */
  buildStagesDone: number | null;
  /** Total build/direct_build thread groups in the job's plan. */
  buildStagesTotal: number | null;
  /** Failure/pause axis, orthogonal to `status` (the build phase) — null when healthy. */
  halt: JobHalt | null;
  /** True only while a "Ship it" is being finalized (PR opening) — keeps the card in "Ready to Ship"
   *  (with the `running` working spinner) instead of routing it to "Building". */
  shipping: boolean;
  /** Who spawned this job (immutable snapshot), or null for a top-level job. */
  createdBy: JobProvenance | null;
  /** The jobs this one is blocked on (live blockers). `[]` unless the job is actually `blocked`. */
  blockedBy: JobBlocker[];
  /** The pending seed message a born-blocked job will start on when it unblocks; null unless `blocked`. */
  blockedSeedMessage: string | null;
  org: { id: string; slug: string; name: string };
  repo: { id: string; name: string };
}

/**
 * Map the slim `JobListItem` (the flat `GET /jobs` row) to the sidebar's `InboxThread`. Org name comes
 * from the session (`useOrgs`); the engine-owned fields (`needsYou`, PR/CI, halt, build stages, …) aren't
 * carried by the read model yet, so they default to a neutral/healthy state until those slices land.
 */
function toInboxThread(
  j: JobListItem,
  orgName: (id: string) => string,
  repoName: (id: string) => string,
): InboxThread {
  return {
    id: j.id,
    title: j.title?.trim() || 'Untitled thread',
    kind: j.kind ?? EJobKind.EVENT, // TODO: Not sure what an InboxThread is, just supplying a default to avoid null
    status: j.status,
    rawStatus: j.status,
    sectionFirstEntered: null,
    activity: j.activity ?? 'idle',
    needsYou: false,
    halted: false,
    createdAt: j.createdAt,
    pr: null,
    ci: null,
    ciCounts: null,
    portState: null,
    buildStagesDone: null,
    buildStagesTotal: null,
    halt: null,
    shipping: false,
    createdBy: null,
    blockedBy: [],
    blockedSeedMessage: null,
    org: { id: j.orgId, slug: j.orgId, name: orgName(j.orgId) },
    repo: { id: j.repoId, name: repoName(j.repoId) },
  };
}

const NOT_ARCHIVED = (j: JobListItem): boolean => !j.archivedAt;
const ARCHIVED = (j: JobListItem): boolean => !!j.archivedAt;

/** Shared: the caller's jobs (`GET /jobs`, RLS-scoped + kept live by the `/jobs/realtime` feed), mapped
 *  to `InboxThread` and filtered active-vs-archived. */
function useInboxJobs(
  keep: (j: JobListItem) => boolean,
  enabled = true,
): QueryResultLike<InboxThread[]> {
  const q = useGetJobsQuery(undefined, { skip: !enabled });
  const { orgs } = useOrgs();
  const { data: repos } = useGetAllReposQuery(undefined, { skip: !enabled });
  const data = useMemo(() => {
    if (!q.data) return undefined;
    const orgNames = new Map(orgs.map((o) => [o.id, o.name] as const));
    const nameOf = (id: string): string => orgNames.get(id) ?? 'Organization';
    const repoNames = new Map((repos ?? []).map((r) => [r.id, r.name] as const));
    const repoOf = (id: string): string => repoNames.get(id) ?? id;
    return q.data.filter(keep).map((j) => toInboxThread(j, nameOf, repoOf));
  }, [q.data, orgs, repos, keep]);
  return { ...adaptQuery(q), data } as QueryResultLike<InboxThread[]>;
}

export function useAllJobs(): QueryResultLike<InboxThread[]> {
  return useInboxJobs(NOT_ARCHIVED);
}

export function useArchivedJobs(enabled: boolean): QueryResultLike<InboxThread[]> {
  return useInboxJobs(ARCHIVED, enabled);
}

export interface RepoThreadGroup {
  repoId: string;
  repoName: string;
  threads: InboxThread[];
}

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
    .map((o) => ({
      orgId: o.orgId,
      orgName: o.orgName,
      repos: [...o.repos.values()],
    }))
    .filter((o) => o.repos.length > 0);
}
