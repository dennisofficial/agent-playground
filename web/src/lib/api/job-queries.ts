'use client';

import {
  useGetJobMessagesQuery,
  useGetJobQuery,
  useGetJobTasksQuery,
} from '@/redux/query/api/jobs.api';
import {
  useGetAllReposQuery,
  useGetOrgReposQuery,
  useGetRepoBranchesQuery,
} from '@/redux/query/api/repo.api';
import type { AutoApproveMode } from '@workspace/shared';
import { useMemo } from 'react';
import { adaptQuery, type QueryResultLike } from './_stub';
import { useMutation, useQuery } from './_tanstack-shim';
import { threadMessageToJobMessage } from './job-adapters';
import {
  addJobDependency,
  approveMcpProposal,
  approveSkillProposal,
  approveThread,
  createJob,
  createJobWithFiles,
  deleteThread,
  fetchContextFile,
  fetchCreatedJobs,
  fetchJobDiff,
  fetchJobDiffSummary,
  fetchRepoFile,
  fetchRepoTree,
  fetchServices,
  fetchThreadContext,
  getDraft,
  postMessage,
  postReviewComments,
  provideSecret,
  removeJobDependency,
  renameJob,
  retryJob,
  retryTurn,
  setAutoApprove,
  setAutoMerge,
  shipWithoutReview,
  spinUpPreview,
  stopJob,
  type ApproveBody,
  type CreateThreadBody,
  type JobMessage,
  type JobRef,
  type MessageInput,
  type ProvideSecretBody,
  type RepoView,
  type ReviewCommentItemBody,
} from './job-api';
import { useOrgs } from './me';
import type { JobBlocker, Pipeline } from './types';

/**
 * Tanstack Query hooks over the org → repo → thread API.
 *
 * STUBBED for the Atlas rebuild: the `/web/orgs/:o/repos/:r/jobs/:j/...` thread backend isn't rebuilt
 * yet, so this module's hooks are slimmed down to bare `queryFn`/`mutationFn` wrappers (kept only so
 * their return types keep inferring from the underlying `job-api` functions). The `_tanstack-shim`
 * ignores queryFn/mutationFn: reads render empty, writes throw "Not Implemented" on invoke. All the
 * cache-invalidation/optimistic-update logic that used to live here is gone — re-add it once the
 * backend exists. The two RTK-wired repo hooks (`useOrgRepos`, `useRepoBranches`) are live.
 */

export interface RepoChoice {
  orgId: string;
  orgName: string;
  repo: RepoView;
}

/**
 * Every connected repo across all the operator's orgs. Built from the session orgs + one
 * `GET /orgs/:id/repos` per org (parallel). Only `accessOk` repos are conversation containers, but we
 * return all connected repos and let the caller reflect emptiness.
 */
/** Every connected repo across the operator's orgs (`GET /repos`, member-scoped), each paired with its
 *  org name (from the session) — the create-job picker's source. */
export function useAllRepos(): { repos: RepoChoice[]; isLoading: boolean } {
  const { data = [], isLoading } = useGetAllReposQuery();
  const { orgs } = useOrgs();
  const repos = useMemo(() => {
    const orgName = new Map(orgs.map((o) => [o.id, o.name] as const));
    return data.map((r) => ({
      orgId: r.orgId,
      orgName: orgName.get(r.orgId) ?? 'Organization',
      repo: r,
    }));
  }, [data, orgs]);
  return { repos, isLoading };
}

/** The job's durable transcript (all threads; the conversation scopes per lane client-side). Wired to
 *  `GET /jobs/:id/messages` and kept live by its realtime feed. */
export function useJobMessages(ref: JobRef): QueryResultLike<JobMessage[]> {
  const q = useGetJobMessagesQuery(ref.jobId);
  const data = useMemo(() => q.data?.map(threadMessageToJobMessage), [q.data]);
  return { ...adaptQuery(q), data } as QueryResultLike<JobMessage[]>;
}

/**
 * The caller's own server-backed composer draft for one job. The `composerStore` singleton owns the
 * authoritative in-memory copy (paint + autosave + realtime reconcile); this hook exists so the drafts
 * realtime path can drive a declarative refetch through the query cache (`qk.draft`) for any component
 * that wants it. The store does its own `getDraft` fetch on hydrate, so this is not the store's paint path.
 */
export function useDraft(ref: JobRef) {
  return useQuery({ queryFn: () => getDraft(ref) });
}

/** A job's pipeline — the shared `JobView` (`GET /jobs/:id`, its nested thread-group→thread tree) paired
 *  with its flat task feed (`/tasks`). Components read these DTOs directly; derivations + the not-yet-emitted
 *  fields live in `job-workspace/lib/pipeline-selectors.ts` (e.g. `activeJob` narrows to the built job). */
export function usePipeline(ref: JobRef): QueryResultLike<Pipeline> {
  const jobQ = useGetJobQuery(ref.jobId);
  const tasksQ = useGetJobTasksQuery(ref.jobId);
  const data = useMemo<Pipeline | undefined>(
    () => (jobQ.data ? { job: jobQ.data, tasks: tasksQ.data ?? [] } : undefined),
    [jobQ.data, tasksQ.data],
  );
  return { ...adaptQuery(jobQ), data } as QueryResultLike<Pipeline>;
}

export function useJobContext(ref: JobRef) {
  return useQuery({ queryFn: () => fetchThreadContext(ref) });
}

export function useContextFile(ref: JobRef, path: string | null) {
  return useQuery({ queryFn: () => fetchContextFile(ref, path!) });
}

/** The job's accumulated multi-file diff. Lazy — only fetched while the Changes pane is open (`enabled`).
 *  SSE invalidates it on repo-file writes + turn end (`useJobEvents`), so it refreshes live as the build edits. */
export function useJobDiff(ref: JobRef, enabled: boolean) {
  return useQuery({ queryFn: () => fetchJobDiff(ref) });
}

/** The job's cheap numstat-only diff summary (no hunks) — for the always-mounted sidebar's +/- totals.
 *  SSE invalidates it alongside the full diff, so the counts stay live without holding the heavy query open. */
export function useJobDiffSummary(ref: JobRef, enabled: boolean) {
  return useQuery({ queryFn: () => fetchJobDiffSummary(ref) });
}

/** The job worktree's tracked-file manifest — fetched once per viewing session to verify file-path spans.
 *  The tree rarely changes while viewing, so keep it fresh for the whole session. */
export function useRepoTree(ref: JobRef) {
  return useQuery({ queryFn: () => fetchRepoTree(ref) });
}

export function useRepoFile(ref: JobRef, path: string | null) {
  return useQuery({ queryFn: () => fetchRepoFile(ref, path!) });
}

/**
 * A thread's `atlas-svc` supervised processes — a DURABLE snapshot (marker files), not a live liveness
 * check, so poll modestly while a workspace tab is open to catch state the agent just changed.
 */
export function useServices(ref: JobRef) {
  return useQuery({ queryFn: () => fetchServices(ref) });
}

/**
 * An org's connected repos — the create-job + settings repo list. **Realtime**: a pgbase live query
 * on `Repo` (connect/update/revalidate/disconnect arrive as WAL deltas) — no manual invalidation.
 */
export function useOrgRepos(orgId: string) {
  return adaptQuery(useGetOrgReposQuery(orgId, { skip: !orgId }));
}

export function useRepoBranches(_orgId: string, repoId: string) {
  return adaptQuery(useGetRepoBranchesQuery({ repoId }, { skip: !repoId }));
}

export function useJobCreatedJobs(ref: JobRef) {
  return useQuery({ queryFn: () => fetchCreatedJobs(ref) });
}

/** One pending composer attachment: the `File` to upload + its local blob preview URL + image/file kind.
 *  Used by the LOCAL-mode tray only (the New-job modal, which uploads its files at create time). */
export interface PendingAttachment {
  file: File;
  /** `URL.createObjectURL(file)` — the instant local preview (revoked by the composer on send/remove). */
  url: string;
  kind: 'image' | 'file';
}

/**
 * A server-backed draft attachment (in-job composer, store-mode) — already uploaded via
 * `POST .../draft/attachments`; unlike `PendingAttachment` it carries NO raw `File`. `url` is a
 * same-session-only local objectURL preview (set at add-time from the picked File, before the upload even
 * confirms) — absent after a hydration from `GET /draft` (no bytes endpoint for draft attachments exists,
 * so a reload shows the name/kind chip without a thumbnail). `pending` marks an optimistic entry whose
 * upload hasn't resolved yet: its `id` is a client temp id, not a server row id (so a `remove` of it must
 * NOT hit the server).
 */
export interface DraftAttachment {
  id: string;
  name: string;
  kind: 'image' | 'file';
  size: number;
  url?: string;
  pending?: boolean;
}

/** `useMessage`'s mutation input — a typed batch and the lane/thread the optimistic row belongs to.
 *  Attachments are NO LONGER sent here: the in-job composer uploads them on-add to the server draft, and
 *  the send-path server-side `promoteOnSend` moves the already-uploaded draft attachments into the message. */
export interface MessageSendInput {
  messages: MessageInput[];
  threadId?: string;
}

/**
 * Post a typed message batch into the thread — the ONE send path (`POST …/message`) that replaces the old
 * `say`/`answer-question`/`provide-file`/`answer-batch` endpoints. When the batch carries a `user` item,
 * optimistically appends a local user bubble (with an `attachments_card` of LOCAL blob URLs when
 * `attachments` are present) so the composer feels instant; the authoritative list is refetched on settle
 * (and again when the SSE signal fires), which reconciles the optimistic row with the durable one. A
 * card-only batch (staged answers with no `user` item) has no optimistic row — the tray just clears on
 * success and the thread refetches, same as the old `answer-batch`.
 *
 * Steering is server-side: a message sent WHILE a turn is live is injected into the running turn by the
 * backend (the model reacts mid-turn) instead of queuing — so there's no client-side queue. The optimistic
 * bubble renders inline at its natural position and reconciles to the durable row (ordered by `created_at`,
 * stamped ≈ send time), landing in the right chronological spot.
 */
export function useMessage(ref: JobRef) {
  return useMutation({ mutationFn: (input: MessageSendInput) => postMessage(ref, input.messages) });
}

/**
 * Gracefully stop the thread brain's in-flight turn — the composer's Stop button (shown when a turn is
 * active AND the textarea is empty). No optimistic row (the turn's own `turn_end` clears the live
 * indicator). Refreshes the message log so any partial output the stop persisted settles.
 */
export function useStop(ref: JobRef) {
  return useMutation({ mutationFn: () => stopJob(ref) });
}

interface ReviewCommentsSendInput {
  items: ReviewCommentItemBody[];
  message?: string;
  threadId?: string;
}

/**
 * Send a batch of inline highlight-and-comments — mirrors `useMessage`'s optimistic-append, but the
 * optimistic row carries the `review_comments_card` so it renders as the styled card immediately (not a
 * plain bubble) while the durable echo settles. A send mid-turn steers server-side (no client queue).
 */
export function useSendReviewComments(ref: JobRef) {
  return useMutation({
    mutationFn: (input: ReviewCommentsSendInput) => postReviewComments(ref, input),
  });
}

/**
 * Submit a plan/ship/merge verdict (approve / request changes / deny). For plan and ship, every verdict
 * flips the job status (→ running / planning / cancelled), which the WAL realtime stream
 * (`useAllJobsRealtime`) delivers race-free on the DB commit and uses to invalidate this thread's
 * pipeline + messages — so there's no `onSuccess`/`onSettled` refetch race there (the mutation resolves
 * instantly, well before the async status flip happens).
 *
 * The MERGE action is different: the backend now AWAITS the merge before responding, so this request's
 * promise doesn't resolve until the merge has fully succeeded or failed — the status flip has already
 * happened server-side by the time we get a response. An `onSettled` invalidate is therefore safe (it
 * can't race the flip) and desired: it lets the Merge PR card unmount promptly on either outcome. This
 * invalidate is scoped to the MERGE action only — for every other verdict (plan/ship/amend/retract/
 * db-write) an unconditional invalidate here would race the async status flip and re-cache stale state,
 * which is exactly what the WAL-driven realtime refetch above is there to avoid.
 */
export function useApprove(ref: JobRef) {
  return useMutation({ mutationFn: (body: ApproveBody) => approveThread(ref, body) });
}

/** Re-drive a halted (failed/paused) build — the navigator "Retry"/"Re-ping" buttons. Refreshes the
 *  pipeline + conversation + inbox so the thread flips back to running. */
export function useRetryJob(ref: JobRef) {
  return useMutation({ mutationFn: (opts?: { force?: boolean }) => retryJob(ref, opts) });
}

/** "Ship without review" on a `codex_review_unavailable`-held job — skip the unreachable Codex
 *  master_review and land at the normal ship-review gate. Refreshes the pipeline (the banner clears in
 *  favor of the ship-review card) + messages + the job list. */
export function useShipWithoutReview(ref: JobRef) {
  return useMutation({ mutationFn: () => shipWithoutReview(ref) });
}

/** The "Resume" button on a `retryable` system→operator error box — re-pokes the same engine session
 *  with no new operator message. Refreshes messages (+ the live stream picks up the resumed turn). */
export function useRetryTurn(ref: JobRef) {
  return useMutation({ mutationFn: (opts?: { force?: boolean }) => retryTurn(ref, opts) });
}

/** Manually block this job on another (the kebab "Block on another job…"). Refreshes the pipeline (the
 *  status flips to `blocked` + the "Blocked by" row appears) and the inbox. */
export function useAddJobDependency(ref: JobRef) {
  return useMutation({
    mutationFn: (dependsOnJobId: string) => addJobDependency(ref, dependsOnJobId),
  });
}

/** Remove one blocker edge (the kebab "Unblock" calls this once per current blocker). Refreshes the
 *  pipeline + inbox so a fully-cleared job flips back off `blocked`. */
export function useRemoveJobDependency(ref: JobRef) {
  return useMutation({
    mutationFn: (dependsOnJobId: string) => removeJobDependency(ref, dependsOnJobId),
  });
}

/** Removes EVERY current blocker edge in one go (the kebab "Unblock" and the conversation-pane blocked
 *  overlay share this) — the backend has no batch endpoint, so it fires one `DELETE …/dependencies/:id`
 *  per blocker. Once the last edge is gone the backend flips the job off `blocked` and wakes its brain. */
export function useUnblockJob(ref: JobRef, blockedBy: JobBlocker[]) {
  return useMutation({
    mutationFn: () => Promise.all(blockedBy.map((b) => removeJobDependency(ref, b.jobId))),
  });
}

/** "Spin up preview" at the ship gate — POSTs the dedicated seeder endpoint (not the generic `say` path),
 *  which injects the full preview procedure server-side and stamps the ship card `previewRequestedAt`.
 *  Refreshes the conversation + pipeline so the stamped card or an off-gate no-op hides stale buttons. */
export function useSpinUpPreview(ref: JobRef) {
  return useMutation({ mutationFn: () => spinUpPreview(ref) });
}

/** Provide a secret value for a `request_secret` card (repo onboarding). The value goes straight to the
 *  encrypted store; the card flips to "provided" and the brain continues. */
export function useProvideSecret(ref: JobRef) {
  return useMutation({ mutationFn: (body: ProvideSecretBody) => provideSecret(ref, body) });
}

/** Approve an `propose_mcp_servers` proposal (repo onboarding; owner-only). Registers each server on the
 *  repo; the card flips to "registered" and the brain continues. Refreshes the org MCP-servers list too. */
export function useApproveMcpProposal(ref: JobRef) {
  return useMutation({
    mutationFn: (requestId: string) => approveMcpProposal(ref, requestId),
  });
}

/** Approve a skill proposal (owner-only). Installs/vendors/removes per the card's mode; the card flips to
 *  "approved" and the brain continues. Refreshes the org skills list too. */
export function useApproveSkillProposal(ref: JobRef) {
  return useMutation({
    mutationFn: (requestId: string) => approveSkillProposal(ref, requestId),
  });
}

/**
 * Create a thread in a repo (posts the first message, optionally with attachments). Invalidates the
 * cross-org inbox on success. When `files` are present the request goes multipart (`createJobWithFiles`).
 */
export function useCreateThread(orgId: string, repoId: string) {
  return useMutation({
    mutationFn: (body: CreateThreadBody & { files?: File[] }) => {
      const { files, ...rest } = body;
      return files?.length
        ? createJobWithFiles(orgId, repoId, rest, files)
        : createJob(orgId, repoId, rest);
    },
  });
}

export function useRenameJob(ref: JobRef) {
  return useMutation({ mutationFn: (title: string) => renameJob(ref, title) });
}

/** Flip the job's auto-approve flag. Invalidate the pipeline so the toggle reflects immediately (the flag
 *  lives on the pipeline job); the realtime stream may also refresh it, but the explicit invalidate wins. */
export function useSetAutoApprove(ref: JobRef) {
  return useMutation({ mutationFn: (mode: AutoApproveMode) => setAutoApprove(ref, mode) });
}

export function useSetAutoMerge(ref: JobRef) {
  return useMutation({
    mutationFn: (body: { autoMerge: boolean }) => setAutoMerge(ref, body),
  });
}

/** Archive a thread (closes its sandbox, flips its status to the terminal `archived`). Refreshes the
 *  inbox (the job drops out of the active sidebar groups), this job's own pipeline (so its `status`
 *  recomputes to `archived` and the open workspace page goes read-only without a manual reload), and the
 *  collapsed Archived sidebar group (so it picks up the job next time it's expanded/refetched). */
export function useDeleteJob(ref: JobRef) {
  return useMutation({ mutationFn: (prAction?: 'close' | 'leave') => deleteThread(ref, prAction) });
}
