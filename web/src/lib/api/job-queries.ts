"use client";

import { useMemo } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { qk } from "./query-keys";
import { useOrgs } from "./me";
import {
  addJobDependency,
  answerQuestion,
  provideSecret,
  provideFile,
  approveMcpProposal,
  approveSkillProposal,
  approveThread,
  createJob,
  createJobWithFiles,
  deleteThread,
  fetchContextFile,
  fetchCreatedJobs,
  fetchJobDiff,
  fetchMessages,
  fetchOrgRepos,
  fetchRepoBranches,
  fetchRepoTree,
  fetchRepoFile,
  fetchPipeline,
  fetchServices,
  fetchThreadContext,
  postReviewComments,
  removeJobDependency,
  renameJob,
  setAutoApprove,
  setAutoMerge,
  acceptThread,
  retryJob,
  retryTurn,
  retryVerification,
  sayMessage,
  sayMessageWithFiles,
  spinUpPreview,
  stopJob,
  type AnswerQuestionBody,
  type ProvideSecretBody,
  type ProvideFileBody,
  type ApproveBody,
  type CreateThreadBody,
  type JobMessage,
  type JobRef,
  type RepoView,
  type ReviewCommentItemBody,
} from "./job-api";
import type { AutoApproveMode } from "@workspace/shared";
import type {
  JobBlocker,
  WebAttachmentsCard,
  WebReviewCommentsCard,
} from "./types";

/** Tanstack Query hooks over the org → repo → thread API. */

const hasRef = (ref: JobRef) => Boolean(ref.orgId && ref.repoId && ref.jobId);

/** A repo in a flat cross-org picker — its org context + the connected-repo view. */
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
export function useAllRepos(): { repos: RepoChoice[]; isLoading: boolean } {
  const { orgs, isLoading: orgsLoading } = useOrgs();
  const results = useQueries({
    queries: orgs.map((o) => ({
      queryKey: qk.orgRepos(o.id),
      queryFn: () => fetchOrgRepos(o.id),
      staleTime: 30_000,
    })),
  });

  const repos = useMemo(() => {
    const out: RepoChoice[] = [];
    orgs.forEach((o, i) => {
      const list = results[i]?.data ?? [];
      for (const repo of list) out.push({ orgId: o.id, orgName: o.name, repo });
    });
    return out;
  }, [orgs, results]);

  const isLoading = orgsLoading || results.some((r) => r.isLoading);
  return { repos, isLoading };
}

/** A thread's durable message log. SSE keeps it fresh via `useJobEvents` (refetch on any frame). */
export function useJobMessages(ref: JobRef) {
  return useQuery({
    queryKey: qk.threadMessages(ref),
    queryFn: () => fetchMessages(ref),
    enabled: hasRef(ref),
    staleTime: 5_000,
  });
}

/** A thread's pipeline (job + threads), or `{ status: 'no_job' }` before a plan is approved. */
export function usePipeline(ref: JobRef) {
  return useQuery({
    queryKey: qk.threadPipeline(ref),
    queryFn: () => fetchPipeline(ref),
    enabled: hasRef(ref),
    staleTime: 5_000,
  });
}

/** A thread's `/context` files (specs + artifacts). SSE keeps it fresh via `useJobEvents`. */
export function useJobContext(ref: JobRef) {
  return useQuery({
    queryKey: qk.threadContext(ref),
    queryFn: () => fetchThreadContext(ref),
    enabled: hasRef(ref),
    staleTime: 5_000,
  });
}

/** One `/context` file's content (`path` bucket-relative, e.g. `specs/plan.md`). Lazy — only when opened. */
export function useContextFile(ref: JobRef, path: string | null) {
  return useQuery({
    queryKey: qk.threadContextFile(ref, path ?? ""),
    queryFn: () => fetchContextFile(ref, path!),
    enabled: hasRef(ref) && Boolean(path),
    staleTime: 5_000,
  });
}

/** The job's accumulated multi-file diff. Lazy — only fetched while the Changes pane is open (`enabled`).
 *  SSE invalidates it on repo-file writes + turn end (`useJobEvents`), so it refreshes live as the build edits. */
export function useJobDiff(ref: JobRef, enabled: boolean) {
  return useQuery({
    queryKey: qk.jobDiff(ref),
    queryFn: () => fetchJobDiff(ref),
    enabled: enabled && hasRef(ref),
  });
}

/** The job worktree's tracked-file manifest — fetched once per viewing session to verify file-path spans.
 *  The tree rarely changes while viewing, so keep it fresh for the whole session. */
export function useRepoTree(ref: JobRef) {
  return useQuery({
    queryKey: qk.repoTree(ref),
    queryFn: () => fetchRepoTree(ref),
    enabled: hasRef(ref),
    staleTime: Infinity,
  });
}

/** One repo file's content (LIVE worktree). Lazy — only when a path is set (a file view is open). */
export function useRepoFile(ref: JobRef, path: string | null) {
  return useQuery({
    queryKey: qk.repoFile(ref, path ?? ""),
    queryFn: () => fetchRepoFile(ref, path!),
    enabled: hasRef(ref) && Boolean(path),
    staleTime: 5_000,
  });
}

/**
 * A thread's `atlas-svc` supervised processes — a DURABLE snapshot (marker files), not a live liveness
 * check, so poll modestly while a workspace tab is open to catch state the agent just changed.
 */
export function useServices(ref: JobRef) {
  return useQuery({
    queryKey: qk.threadServices(ref),
    queryFn: () => fetchServices(ref),
    enabled: hasRef(ref),
    staleTime: 4_000,
    refetchInterval: 5_000,
  });
}

/** An org's connected repos — the create-job repo picker. */
export function useOrgRepos(orgId: string) {
  return useQuery({
    queryKey: qk.orgRepos(orgId),
    queryFn: () => fetchOrgRepos(orgId),
    enabled: Boolean(orgId),
    staleTime: 30_000,
  });
}

/** A repo's branches — the create-job base-branch picker (hits GitHub via the org token). */
export function useRepoBranches(orgId: string, repoId: string) {
  return useQuery({
    queryKey: qk.repoBranches(orgId, repoId),
    queryFn: () => fetchRepoBranches(orgId, repoId),
    enabled: Boolean(orgId && repoId),
    staleTime: 30_000,
  });
}

/** Jobs Atlas spawned FROM this one — the job workspace's "Created jobs" panel. */
export function useJobCreatedJobs(ref: JobRef) {
  return useQuery({
    queryKey: qk.jobCreated(ref.orgId, ref.repoId, ref.jobId),
    queryFn: () => fetchCreatedJobs(ref),
    enabled: hasRef(ref),
    staleTime: 10_000,
  });
}

interface SayContext {
  prev?: JobMessage[];
}

/**
 * Post a message into the thread. Optimistically appends a local user bubble so the composer feels
 * instant; the authoritative list is refetched on settle (and again when the SSE signal fires), which
 * reconciles the optimistic row with the durable one.
 *
 * Steering is now server-side: a message sent WHILE a turn is live is injected into the running turn by the
 * backend (the model reacts mid-turn) instead of queuing — so there's no client-side queue. The optimistic
 * bubble renders inline at its natural position and reconciles to the durable row (ordered by `created_at`,
 * stamped ≈ send time), landing in the right chronological spot.
 */
export function useSay(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation<{ ts: string }, Error, string, SayContext>({
    mutationFn: (text: string) => sayMessage(ref, text),
    onMutate: async (text) => {
      const key = qk.threadMessages(ref);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<JobMessage[]>(key);
      const optimistic: JobMessage = {
        ts: `local-${Date.now()}`,
        author: "user",
        authorId: "me",
        authorName: "You",
        text,
        kind: "chat",
        source: "operator",
        postedAt: new Date().toISOString(),
        local: true,
      };
      qc.setQueryData<JobMessage[]>(key, [...(prev ?? []), optimistic]);
      return { prev };
    },
    onError: (_e, _text, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.threadMessages(ref), ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
    },
  });
}

/** One pending composer attachment: the `File` to upload + its local blob preview URL + image/file kind. */
export interface PendingAttachment {
  file: File;
  /** `URL.createObjectURL(file)` — the instant local preview (revoked by the composer on send/remove). */
  url: string;
  kind: "image" | "file";
}

interface SayWithAttachmentsInput {
  text: string;
  attachments: PendingAttachment[];
}

/**
 * Send a message WITH attachments (multipart). Mirrors `useSay`'s optimistic-append, but the optimistic row
 * carries an `attachments_card` whose items use the LOCAL blob URLs (`localUrl`) so thumbnails render
 * instantly; on settle the durable row (server `path`, served via the streaming raw endpoint) reconciles in.
 */
export function useSayWithAttachments(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation<
    { ts: string },
    Error,
    SayWithAttachmentsInput,
    SayContext
  >({
    mutationFn: (input) =>
      sayMessageWithFiles(
        ref,
        input.text,
        input.attachments.map((a) => a.file),
      ),
    onMutate: async (input) => {
      const key = qk.threadMessages(ref);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<JobMessage[]>(key);
      const card: WebAttachmentsCard = {
        type: "attachments_card",
        items: input.attachments.map((a) => ({
          name: a.file.name,
          path: "",
          kind: a.kind,
          size: a.file.size,
          localUrl: a.url,
        })),
        ...(input.text ? { message: input.text } : {}),
      };
      const optimistic: JobMessage = {
        ts: `local-${Date.now()}`,
        author: "user",
        authorId: "me",
        authorName: "You",
        text: input.text,
        kind: "chat",
        source: "operator",
        card,
        postedAt: new Date().toISOString(),
        local: true,
      };
      qc.setQueryData<JobMessage[]>(key, [...(prev ?? []), optimistic]);
      return { prev };
    },
    onError: (_e, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.threadMessages(ref), ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
    },
  });
}

/**
 * Gracefully stop the thread brain's in-flight turn — the composer's Stop button (shown when a turn is
 * active AND the textarea is empty). Mirrors `useSay`'s shape; no optimistic row (the turn's own `turn_end`
 * clears the live indicator). Refreshes the message log so any partial output the stop persisted settles.
 */
export function useStop(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation<{ stopped: boolean }, Error, void>({
    mutationFn: () => stopJob(ref),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
    },
  });
}

interface ReviewCommentsSendInput {
  items: ReviewCommentItemBody[];
  message?: string;
}

/**
 * Send a batch of inline highlight-and-comments — mirrors `useSay`'s optimistic-append, but the optimistic
 * row carries the `review_comments_card` so it renders as the styled card immediately (not a plain bubble)
 * while the durable echo settles. Like `say`, a send mid-turn steers server-side (no client queue).
 */
export function useSendReviewComments(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation<
    { ts: string },
    Error,
    ReviewCommentsSendInput,
    SayContext
  >({
    mutationFn: (input) => postReviewComments(ref, input),
    onMutate: async (input) => {
      const key = qk.threadMessages(ref);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<JobMessage[]>(key);
      const card: WebReviewCommentsCard = {
        type: "review_comments_card",
        items: input.items,
        ...(input.message ? { message: input.message } : {}),
      };
      const optimistic: JobMessage = {
        ts: `local-${Date.now()}`,
        author: "user",
        authorId: "me",
        authorName: "You",
        text: input.message ?? "",
        kind: "chat",
        source: "operator",
        card,
        postedAt: new Date().toISOString(),
        local: true,
      };
      qc.setQueryData<JobMessage[]>(key, [...(prev ?? []), optimistic]);
      return { prev };
    },
    onError: (_e, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.threadMessages(ref), ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
    },
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
 * can't race the flip) and desired: it lets the Merge PR card unmount promptly on either outcome.
 */
export function useApprove(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ApproveBody) => approveThread(ref, body),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.threadPipeline(ref) }),
  });
}

/** Re-drive a halted (failed/paused) build — the navigator "Retry"/"Re-ping" buttons. Refreshes the
 *  pipeline + conversation + inbox so the thread flips back to running. */
export function useRetryJob(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => retryJob(ref),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadPipeline(ref) });
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
}

/** "Retry now" on a `judge_unavailable`-stuck thread — force a fresh re-drive of the live judge. Refreshes
 *  the pipeline (the lane flips back to running) + messages + the job list. */
export function useRetryVerification(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) => retryVerification(ref, threadId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadPipeline(ref) });
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
}

/** "Skip & accept" on a `judge_unavailable`-stuck thread — force-complete it (bypassing only the live
 *  judge) and advance the job. Refreshes the pipeline (the lane flips to done) + messages + the job list. */
export function useAcceptThread(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) => acceptThread(ref, threadId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadPipeline(ref) });
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
}

/** The "Resume" button on a `retryable` system→operator error box — re-pokes the same engine session
 *  with no new operator message. Refreshes messages (+ the live stream picks up the resumed turn). */
export function useRetryTurn(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => retryTurn(ref),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
    },
  });
}

/** Manually block this job on another (the kebab "Block on another job…"). Refreshes the pipeline (the
 *  status flips to `blocked` + the "Blocked by" row appears) and the inbox. */
export function useAddJobDependency(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dependsOnJobId: string) =>
      addJobDependency(ref, dependsOnJobId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadPipeline(ref) });
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
}

/** Remove one blocker edge (the kebab "Unblock" calls this once per current blocker). Refreshes the
 *  pipeline + inbox so a fully-cleared job flips back off `blocked`. */
export function useRemoveJobDependency(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dependsOnJobId: string) =>
      removeJobDependency(ref, dependsOnJobId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadPipeline(ref) });
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
}

/** Removes EVERY current blocker edge in one go (the kebab "Unblock" and the conversation-pane blocked
 *  overlay share this) — the backend has no batch endpoint, so it fires one `DELETE …/dependencies/:id`
 *  per blocker. Once the last edge is gone the backend flips the job off `blocked` and wakes its brain. */
export function useUnblockJob(ref: JobRef, blockedBy: JobBlocker[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      Promise.all(blockedBy.map((b) => removeJobDependency(ref, b.jobId))),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadPipeline(ref) });
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
}

/** Answer a formal `ask_question` card. Refreshes the conversation (the card flips to answered + the
 *  brain's next turn lands). */
export function useAnswerQuestion(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AnswerQuestionBody) => answerQuestion(ref, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
    },
  });
}

/** "Spin up preview" at the ship gate — POSTs the dedicated seeder endpoint (not the generic `say` path),
 *  which injects the full preview procedure server-side and stamps the ship card `previewRequestedAt`.
 *  Refreshes the conversation + pipeline so the stamped card or an off-gate no-op hides stale buttons. */
export function useSpinUpPreview(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => spinUpPreview(ref),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
      void qc.invalidateQueries({ queryKey: qk.threadPipeline(ref) });
    },
  });
}

/** Provide a secret value for a `request_secret` card (repo onboarding). The value goes straight to the
 *  encrypted store; the card flips to "provided" and the brain continues. */
export function useProvideSecret(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProvideSecretBody) => provideSecret(ref, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
    },
  });
}

/** Approve an `propose_mcp_servers` proposal (repo onboarding; owner-only). Registers each server on the
 *  repo; the card flips to "registered" and the brain continues. Refreshes the org MCP-servers list too. */
export function useApproveMcpProposal(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) => approveMcpProposal(ref, requestId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
      void qc.invalidateQueries({ queryKey: qk.orgMcpServers(ref.orgId) });
    },
  });
}

/** Approve a skill proposal (owner-only). Installs/vendors/removes per the card's mode; the card flips to
 *  "approved" and the brain continues. Refreshes the org skills list too. */
export function useApproveSkillProposal(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) => approveSkillProposal(ref, requestId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
      void qc.invalidateQueries({ queryKey: qk.orgSkills(ref.orgId) });
    },
  });
}

/** Upload a file for a `request_file` card (repo onboarding). The contents go straight to the encrypted
 *  store; the card flips to "uploaded" and the brain continues. */
export function useProvideFile(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProvideFileBody) => provideFile(ref, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
    },
  });
}

/**
 * Create a thread in a repo (posts the first message, optionally with attachments). Invalidates the
 * cross-org inbox on success. When `files` are present the request goes multipart (`createJobWithFiles`).
 */
export function useCreateThread(orgId: string, repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateThreadBody & { files?: File[] }) => {
      const { files, ...rest } = body;
      return files?.length
        ? createJobWithFiles(orgId, repoId, rest, files)
        : createJob(orgId, repoId, rest);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
}

/** Rename a thread (the only thread Update op). Refreshes the inbox so the new title shows everywhere. */
export function useRenameJob(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => renameJob(ref, title),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
}

/** Flip the job's auto-approve flag. Invalidate the pipeline so the toggle reflects immediately (the flag
 *  lives on the pipeline job); the realtime stream may also refresh it, but the explicit invalidate wins. */
export function useSetAutoApprove(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: AutoApproveMode) => setAutoApprove(ref, mode),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: qk.threadPipeline(ref) }),
  });
}

/** Flip the job's auto-merge settings. Invalidate the pipeline so the popover reflects immediately. */
export function useSetAutoMerge(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { autoMerge: boolean }) => setAutoMerge(ref, body),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: qk.threadPipeline(ref) }),
  });
}

/** Delete a thread (closes its sandbox + removes its messages). Refreshes the inbox. */
export function useDeleteJob(ref: JobRef) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (prAction?: "close" | "leave") => deleteThread(ref, prAction),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
}
