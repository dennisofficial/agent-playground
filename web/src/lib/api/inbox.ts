"use client";

import { useQuery } from "@tanstack/react-query";
import { env } from "@/lib/env";
import { fetchWithRefresh } from "./refresh";
import { qk } from "./query-keys";
import { toJobStatus, toJobKind } from "./status";
import type {
  WireJobStatus,
  WireJobKind,
  WireJobHalt,
  WireJobActivity,
  JobStatus,
  JobKind,
  InboxPr,
  CiStatus,
} from "./types";

/**
 * The unified cross-org inbox — every thread across ALL the operator's orgs (`GET /web/jobs`), the
 * data behind the "All organizations" board and the org-grouped sidebar. The endpoint is login-gated and
 * inherently scoped to the caller's memberships; each row carries its org + repo so the UI can label it.
 *
 * The row carries a server-owned `status` + `needsYou` ("needs you" = the AI isn't actively working and
 * the thread isn't terminal — see the backend `deriveNeedsYou`). These power the status pie + the alert
 * dot for EVERY thread, not just the open one; a realtime feed keeps them live (see `useAllJobsRealtime`).
 */

export interface RawInboxThread {
  jobId: string;
  title: string | null;
  origin: string; // 'chat' | 'event' | 'control'
  /** The job's build kind ('feature' | 'bugfix' | 'onboarding' | 'event'); null until scoped. Preferred
   *  over `origin` for the badge when present (see `deriveInboxKind`). */
  kind?: string | null;
  /** Raw backend thread status ('open' | 'planning' | … | 'cancelled'). */
  status: string;
  /** Orthogonal backend activity axis; the server folds this into `needsYou`. */
  activity: WireJobActivity;
  /** Server-derived: the thread is awaiting the operator (AI idle, not terminal). */
  needsYou: boolean;
  /** An unresolved turn-failure box is outstanding — the sidebar renders the failed-style ✕ glyph
   *  regardless of `status`, and `needsYou` is already true. */
  halted: boolean;
  createdAt: string;
  /** The observed PR (null until one exists) — drives the sidebar PR-status glyph. */
  pr?: InboxPr | null;
  /** Aggregate CI outcome for the PR head (`jobs.ci_status`) — the backend list projection emits it as
   *  `ciStatus`. null = no checks reported. */
  ciStatus?: CiStatus | null;
  /** Failure/pause axis, orthogonal to `status` (the build phase) — null when healthy. */
  halt?: WireJobHalt | null;
  org: { id: string; slug?: string; name?: string };
  repo: { id: string; name?: string };
}

export interface InboxThread {
  id: string;
  title: string;
  kind: JobKind;
  /** UI status (mapped from the backend status) — drives the status pie. */
  status: JobStatus;
  /** Backend activity axis, retained so realtime and REST cache rows match the wire contract. */
  activity: WireJobActivity;
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
  /** Failure/pause axis, orthogonal to `status` (the build phase) — null when healthy. */
  halt: WireJobHalt | null;
  org: { id: string; slug: string; name: string };
  repo: { id: string; name: string };
}

/**
 * The badge kind: prefer the authoritative job `kind` when the backend supplies it (covers `onboarding`
 * and scoped feature/bugfix), and fall back to the thread `origin` for older rows where `kind` is null
 * (only `event` is distinguishable from origin; `chat`/`control` read as `feat`).
 */
function deriveInboxKind(r: RawInboxThread): JobKind {
  if (r.kind) return toJobKind(r.kind as WireJobKind);
  return r.origin === "event" ? "event" : "feat";
}

/** Backend status (incl. `open`, which `toJobStatus` doesn't cover) → UI status for the pie. */
export function uiStatus(backend: string, origin: string): JobStatus {
  if (backend === "open") return origin === "event" ? "triaging" : "planning";
  return toJobStatus(backend as WireJobStatus);
}

export function normalize(r: RawInboxThread): InboxThread {
  return {
    id: r.jobId,
    title: r.title?.trim() || "Untitled thread",
    kind: deriveInboxKind(r),
    status: uiStatus(r.status, r.origin),
    activity: r.activity ?? "idle",
    needsYou: r.needsYou,
    halted: r.halted ?? false,
    createdAt: r.createdAt,
    pr: r.pr ?? null,
    ci: r.ciStatus ?? null,
    halt: r.halt ?? null,
    org: {
      id: r.org.id,
      slug: r.org.slug ?? r.org.id,
      name: r.org.name ?? "Organization",
    },
    repo: { id: r.repo.id, name: r.repo.name ?? r.repo.id },
  };
}

async function fetchAllThreads(): Promise<InboxThread[]> {
  const res = await fetchWithRefresh(`${env.NEXT_PUBLIC_HTTP_URL}/web/jobs`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`threads ${res.status}`);
  const rows = (await res.json()) as RawInboxThread[];
  return rows.map(normalize);
}

export function useAllJobs() {
  return useQuery({
    queryKey: qk.allJobs(),
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
    .map((o) => ({
      orgId: o.orgId,
      orgName: o.orgName,
      repos: [...o.repos.values()],
    }))
    .filter((o) => o.repos.length > 0);
}
