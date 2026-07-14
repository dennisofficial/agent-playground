"use client";

import type { AutoApproveMode, AutoMergeMethod } from "@workspace/shared";
import { env } from "@/lib/env";
import { fetchWithRefresh } from "./refresh";
import type {
  ApprovalActionId,
  ContextFileContent,
  InboxPr,
  JobBlocker,
  JobDiff,
  JobProvenance,
  PipelineJob,
  PipelineState,
  JobContext,
  ServiceInfo,
  WebCard,
} from "./types";

/**
 * The org → repo → thread web API (`/web/orgs/:orgId/repos/:repoId/threads/:jobId/...`). Every call
 * is credentialed (the session cookie authorizes the membership-gated routes) and goes through
 * `fetchWithRefresh` so an expired access cookie is re-upped + retried once. This is the real, current
 * contract — it replaces the dead channel client (`client.ts`).
 */

const BASE = `${env.NEXT_PUBLIC_HTTP_URL}/web`;

/** Everything needed to address one thread. The inbox row (`/web/jobs`) carries all three. */
export interface JobRef {
  orgId: string;
  repoId: string;
  jobId: string;
}

export class ThreadApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ThreadApiError";
  }
}

/** A mutation's error, unwrapped to a message worth showing the operator — the backend's own 400 text
 *  (e.g. "can't block a job that is already building or finished…") when we have it, else a flat fallback. */
export function mutationErrorMessage(err: unknown, fallback: string): string {
  return err instanceof ThreadApiError ? err.message : fallback;
}

async function webJson<T>(path: string, init?: RequestInit): Promise<T> {
  // A FormData body must NOT get a hardcoded content-type — the browser sets `multipart/form-data` with the
  // boundary itself. Only JSON string bodies carry the json content-type. (Used by the attachment uploads.)
  const isForm = init?.body instanceof FormData;
  const res = await fetchWithRefresh(`${BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(isForm ? {} : { "content-type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ThreadApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function threadPath(ref: JobRef, suffix = ""): string {
  return `/orgs/${ref.orgId}/repos/${ref.repoId}/jobs/${ref.jobId}${suffix}`;
}

// ── Messages ───────────────────────────────────────────────────────────────────────────────────
/** The durable message row as the backend returns it (`…/threads/:jobId/messages`). */
export interface RawThreadMessage {
  /** The row's uuid — a stable React key (transcript blocks have no surface `ts`). */
  id?: string;
  ts: string | null;
  author: string;
  authorId: string;
  isAtlas: boolean;
  text: string;
  kind: string; // 'chat' | 'thinking' | 'tool' | 'card' | 'build_event'
  /**
   * Message provenance, by AUDIENCE (always set by the `/messages` mapping).
   * `'system_operator'` = system→operator only (e.g. an unresumable-thread error; Atlas didn't author it
   * and never sees it). `'system_shared'` = system→operator AND Atlas (e.g. Codex plan-review findings).
   * `'system_event'` = an automated notification that opened this thread (Atlas got a harness delivery).
   */
  source:
    | "operator"
    | "atlas"
    | "system_operator"
    | "system_shared"
    | "system_event"
    | "system_notice"
    | "system_reminder"
    | "untrusted";
  card?: WebCard | null;
  meta?: Record<string, unknown> | null;
  postedAt: string;
}

/** UI message shape — normalized so the conversation classifier can read it uniformly. */
export interface JobMessage {
  /** Stable key (synthetic monotonic ts; a local optimistic post gets a `local-*` key). */
  ts: string;
  /** `atlas` (the agent) or `user` (a human — the operator). Drives bubble alignment. */
  author: "atlas" | "user";
  authorId: string;
  authorName: string;
  text: string;
  kind: string;
  /**
   * Message provenance, by AUDIENCE (normalize applies a default for older rows). The `system_*` kinds
   * each render as their own distinct block, NOT as an operator or Atlas bubble:
   * `'system_operator'` = system→operator only (e.g. an unresumable-thread error);
   * `'system_shared'`   = system→operator AND Atlas (e.g. Codex plan-review findings);
   * `'system_event'`    = an automated notification that opened this thread (a harness delivery to Atlas).
   */
  source:
    | "operator"
    | "atlas"
    | "system_operator"
    | "system_shared"
    | "system_event"
    | "system_notice"
    | "system_reminder"
    | "untrusted";
  card?: WebCard;
  meta?: Record<string, unknown>;
  postedAt: string;
  /** Client-only: an optimistic post not yet echoed by history. */
  local?: boolean;
}

export function normalizeMessage(r: RawThreadMessage): JobMessage {
  return {
    ts: r.ts ?? r.id ?? `srv-${r.postedAt}`,
    author: r.isAtlas ? "atlas" : "user",
    authorId: r.authorId,
    authorName: r.author,
    text: r.text ?? "",
    kind: r.kind,
    source: r.source,
    card: r.card ?? undefined,
    meta: r.meta ?? undefined,
    postedAt: r.postedAt,
  };
}

export function fetchMessages(ref: JobRef): Promise<JobMessage[]> {
  return webJson<RawThreadMessage[]>(threadPath(ref, "/messages")).then(
    (rows) => rows.map(normalizeMessage),
  );
}

export function sayMessage(ref: JobRef, text: string): Promise<{ ts: string }> {
  return webJson(threadPath(ref, "/say"), {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

/**
 * Send a message WITH attachments — multipart (`text` + repeated `files` parts). Binary all the way (no
 * base64): the files stream to the server, which writes them to the sandbox and points the brain at them.
 */
export function sayMessageWithFiles(
  ref: JobRef,
  text: string,
  files: File[],
): Promise<{ ts: string }> {
  const form = new FormData();
  form.append("text", text);
  for (const f of files) form.append("files", f, f.name);
  return webJson(threadPath(ref, "/say"), { method: "POST", body: form });
}

/**
 * Fetch a composer attachment as a blob object-URL (for `<img>` thumbnails / file links). Uses a
 * credentialed fetch of the STREAMING raw endpoint — never a base64 data URL — so large images don't
 * bloat memory or block. The caller MUST `URL.revokeObjectURL` the result when done.
 */
export async function fetchAttachmentUrl(
  ref: JobRef,
  path: string,
): Promise<string> {
  const res = await fetchWithRefresh(
    `${BASE}${threadPath(ref, "/context/file/raw")}?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new ThreadApiError(res.status, res.statusText);
  return URL.createObjectURL(await res.blob());
}

/**
 * The absolute URL that STREAMS one `/context` file as raw bytes with its real `Content-Type` — used as an
 * `<iframe>` src for the HTML-artifact preview. PATH-based (each segment encoded, slashes preserved) so the
 * document's own RELATIVE sub-resources (`style.css`, images) resolve against it and get fetched too.
 * `path` is bucket-relative, e.g. `artifacts/sidebar-redesign/index.html`. Consumed directly as an
 * `<iframe>` src, so — unlike `fetchAttachmentUrl` — it does NOT flow through `fetchWithRefresh`'s 401
 * retry (an iframe navigation can't); an expired access cookie just means the operator reopens the file
 * after the app refreshes.
 */
export function contextRawUrl(ref: JobRef, path: string): string {
  const encoded = path
    .split("/")
    .filter((seg) => seg.length > 0)
    .map(encodeURIComponent)
    .join("/");
  return `${BASE}${threadPath(ref, `/context/raw/${encoded}`)}`;
}

/**
 * Gracefully stop the thread brain's in-flight turn (the composer's Stop button). Returns `{ stopped }` —
 * `false` if there was no live turn to stop. The backend emits a normal `turn_end` (no separate abort
 * frame), so the live indicator clears through the usual reconcile path.
 */
export function stopJob(ref: JobRef): Promise<{ stopped: boolean }> {
  return webJson(threadPath(ref, "/stop"), { method: "POST" });
}

/** One inline highlight-and-comment item, as sent to `…/jobs/:jobId/review-comments`. */
export interface ReviewCommentItemBody {
  file: string;
  quote: string;
  note?: string;
  /** Line-range anchor for a diff-gutter comment (absent for a free-text selection comment): the old/new
   *  spans covered plus the signed diff fragment the operator selected. */
  lines?: {
    path: string;
    oldStart?: number;
    oldEnd?: number;
    newStart?: number;
    newEnd?: number;
    fragment: string;
  };
}

/**
 * Send a batch of queued review comments — a durable operator message that both drives a brain turn AND
 * renders as the `review_comments_card`. See `review-comments.tsx` for the authoring side.
 */
export function postReviewComments(
  ref: JobRef,
  body: { items: ReviewCommentItemBody[]; message?: string },
): Promise<{ ts: string }> {
  return webJson(threadPath(ref, "/review-comments"), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ── Approvals ──────────────────────────────────────────────────────────────────────────────────
export interface ApproveBody {
  /** The prefixed action id from the card action (e.g. `atlas_approval:approve`). */
  actionId: ApprovalActionId | string;
  /** The card action's verbatim `value` (JSON `{ decisionRecordId, jobId }`). */
  value: string;
  ruledBy: string;
  note?: string;
}

export function approveThread(
  ref: JobRef,
  body: ApproveBody,
): Promise<{ ok: boolean; jobId?: string }> {
  return webJson(threadPath(ref, "/approve"), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ── Formal questions ─────────────────────────────────────────────────────────────────────────────
export interface AnswerQuestionBody {
  /** The question card's id (its message ts). */
  questionId: string;
  /** The picked option's label, or free text. */
  answer: string;
  answeredBy?: string;
}

export function answerQuestion(
  ref: JobRef,
  body: AnswerQuestionBody,
): Promise<{ ok: boolean; ts: string }> {
  return webJson(threadPath(ref, "/answer-question"), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ── Spin up preview (ship gate) ────────────────────────────────────────────────────────────────────
/** Ask the build brain to stand up a demo-ready live preview at the ship gate. Injects the full preview
 *  procedure as a server-side seed turn (not the generic /say path) and stamps the ship card so the button
 *  hides. Gated server-side on `awaiting_ship_review`; a no-op `ok:false` off-gate. */
export function spinUpPreview(
  ref: JobRef,
): Promise<{ ok: boolean; ts: string }> {
  return webJson(threadPath(ref, "/spin-up-preview"), { method: "POST" });
}

// ── Secure secret intake (repo onboarding) ─────────────────────────────────────────────────────────
export interface ProvideSecretBody {
  /** The secret card's id (its message ts). */
  requestId: string;
  /** The plaintext value — sent once over HTTPS to the encrypted store; never round-tripped back. */
  value: string;
}

export function provideSecret(
  ref: JobRef,
  body: ProvideSecretBody,
): Promise<{ ok: boolean; ts: string }> {
  return webJson(threadPath(ref, "/provide-secret"), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ── MCP-proposal approval (repo onboarding; owner-only) ────────────────────────────────────────────
/** Approve a brain `propose_mcp_servers` card — commits each server on the repo (owner-only on the server). */
export function approveMcpProposal(
  ref: JobRef,
  requestId: string,
): Promise<{ ok: boolean; committed: string[]; ts?: string }> {
  return webJson(threadPath(ref, `/mcp-proposals/${requestId}/approve`), {
    method: "POST",
  });
}

// ── Skill-proposal approval (owner-only) ───────────────────────────────────────────────────────────
/** Approve a brain skill proposal — installs (git) / vendors the authored draft / removes, per the card's
 *  mode (owner-only on the server). */
export function approveSkillProposal(
  ref: JobRef,
  requestId: string,
): Promise<{ ok: boolean; name: string; ts?: string }> {
  return webJson(threadPath(ref, `/skill-proposals/${requestId}/approve`), {
    method: "POST",
  });
}

// ── Secure file upload (repo onboarding) ─────────────────────────────────────────────────────────
export interface ProvideFileBody {
  /** The file-request card's id (its message ts). */
  requestId: string;
  /** The operator-chosen filename (metadata only — display/provenance). */
  filename: string;
  /** The file's text contents — sent once over HTTPS to the encrypted store; never round-tripped back. */
  content: string;
}

export function provideFile(
  ref: JobRef,
  body: ProvideFileBody,
): Promise<{ ok: boolean; ts: string }> {
  return webJson(threadPath(ref, "/provide-file"), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Re-drive a halted (failed/paused) build — the navigator "Retry" button. No-op if not retryable. */
export function retryJob(
  ref: JobRef,
): Promise<{ ok: boolean; status: string }> {
  return webJson(threadPath(ref, "/retry"), { method: "POST" });
}

/** "Retry now" on a `judge_unavailable`-stuck thread — force a fresh re-drive (re-runs the live judge),
 *  re-arming the judge-cap re-drive budget. Refused server-side if the hold is not a judge outage. */
export function retryVerification(
  ref: JobRef,
  threadId: string,
): Promise<{ ok: boolean; reason?: string }> {
  return webJson(threadPath(ref, `/threads/${threadId}/retry-verification`), {
    method: "POST",
  });
}

/** "Skip & accept" on a `judge_unavailable`-stuck thread — force-complete the thread, bypassing only the
 *  unreachable live judge, then advance the job. Refused server-side unless the static gate already passed. */
export function acceptThread(
  ref: JobRef,
  threadId: string,
): Promise<{ ok: boolean; reason?: string }> {
  return webJson(threadPath(ref, `/threads/${threadId}/accept`), {
    method: "POST",
  });
}

/**
 * The "Resume" button on a `retryable` system→operator error box (a chat-turn that hit a transient
 * engine failure). Distinct from `retryJob` — this re-pokes the SAME engine session with no new operator
 * message, rather than re-driving a halted BUILD track.
 */
export function retryTurn(ref: JobRef): Promise<{ ok: boolean }> {
  return webJson(threadPath(ref, "/retry-turn"), { method: "POST" });
}

// ── Pipeline ───────────────────────────────────────────────────────────────────────────────────
export function fetchPipeline(ref: JobRef): Promise<PipelineState> {
  return webJson<PipelineState>(threadPath(ref, "/pipeline"));
}

// ── Supervised services (atlas-svc) ───────────────────────────────────────────────────────────
export function fetchServices(
  ref: JobRef,
): Promise<{ services: ServiceInfo[] }> {
  return webJson<{ services: ServiceInfo[] }>(threadPath(ref, "/services"));
}

/** The last-N-lines tail of one supervised process's log — the same content the SSE `snapshot` frame carries. */
export function fetchServiceLogTail(
  ref: JobRef,
  id: string,
): Promise<{ id: string; content: string; truncated: boolean }> {
  return webJson<{ id: string; content: string; truncated: boolean }>(
    threadPath(ref, `/services/${encodeURIComponent(id)}/logs`),
  );
}

/** Narrow a pipeline read to its job, or `null` before a plan is approved (`{ status: 'no_job' }`). */
export function pipelineJob(
  state: PipelineState | undefined,
): PipelineJob | null {
  if (!state || state.status === "no_job") return null;
  return state;
}

// ── Context (specs + artifacts files) ────────────────────────────────────────────────────────────
/** List the thread's `/context` files, grouped into `specs` (plan) + `artifacts` (outputs). */
export function fetchThreadContext(ref: JobRef): Promise<JobContext> {
  return webJson<JobContext>(threadPath(ref, "/context"));
}

/** Read one `/context` file's content (`path` is bucket-relative, e.g. `specs/plan.md`). */
export function fetchContextFile(
  ref: JobRef,
  path: string,
): Promise<ContextFileContent> {
  return webJson<ContextFileContent>(
    threadPath(ref, `/context/file?path=${encodeURIComponent(path)}`),
  );
}

// ── Job diff (accumulated worktree change across all threads) ─────────────────────────────────────
/** The job's accumulated multi-file diff (`GET …/jobs/:jobId/diff`) — the Changes pane's data. */
export function fetchJobDiff(ref: JobRef): Promise<JobDiff> {
  return webJson<JobDiff>(threadPath(ref, "/diff"));
}

// ── Repo files (live job worktree — for spec/plan file-path links) ────────────────────────────────
/** The job worktree's TRACKED-file manifest (git ls-files) — used to verify which inline-code spans name a
 *  real repo file before linkifying them. Empty when the worktree is gone (closed/reset). */
export function fetchRepoTree(ref: JobRef): Promise<{ files: string[] }> {
  return webJson<{ files: string[] }>(threadPath(ref, "/repo/tree"));
}

/** Read one repo file from the LIVE job worktree by git-relative path (tracked files only; 404 otherwise). */
export function fetchRepoFile(
  ref: JobRef,
  path: string,
): Promise<ContextFileContent> {
  return webJson<ContextFileContent>(
    threadPath(ref, `/repo/file?path=${encodeURIComponent(path)}`),
  );
}

// ── Rename (the only thread Update op) ───────────────────────────────────────────────────────────
export function renameJob(
  ref: JobRef,
  title: string,
): Promise<{ ok: boolean; title: string }> {
  return webJson(threadPath(ref), {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

/** Set the job's per-job auto-approve mode (`PATCH …/jobs/:jobId/auto-approve`) — the header popover's
 *  Plan/Ship switches compose into one of the four `AutoApproveMode` values. Enabling a gate the job is
 *  currently parked on also resolves it; the mode is read back from the pipeline. */
export function setAutoApprove(
  ref: JobRef,
  mode: AutoApproveMode,
): Promise<{ ok: boolean; autoApproveMode: AutoApproveMode }> {
  return webJson(threadPath(ref, "/auto-approve"), {
    method: "PATCH",
    body: JSON.stringify({ mode }),
  });
}

/** Set the job's per-job auto-merge settings (`PATCH …/jobs/:jobId/auto-merge`). Enabling on an already
 *  merge-ready PR immediately evaluates/merges (backend). */
export function setAutoMerge(
  ref: JobRef,
  body: { autoMerge: boolean },
): Promise<{ ok: boolean; autoMerge: boolean }> {
  return webJson(threadPath(ref, "/auto-merge"), {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ── Job relationships (created-by / created jobs / manual block & unblock) ─────────────────────────
/** A child job spawned FROM this one (`GET …/jobs/:jobId/created`) — the "Created jobs" navigator row +
 *  detail pane. */
export interface CreatedJobRow {
  id: string;
  title: string | null;
  status: string;
  kind: string | null;
  prState: string | null;
  needsYou: boolean;
  createdAt: string;
}

export function fetchCreatedJobs(ref: JobRef): Promise<CreatedJobRow[]> {
  return webJson<CreatedJobRow[]>(threadPath(ref, "/created"));
}

/** The single-job detail read — used to resolve a `createdBy`/blocker link before navigating to it. A
 *  hard-deleted job 404s (`ThreadApiError.status === 404`), letting the caller toast instead of routing
 *  into a dead thread. */
export interface JobDetail {
  id: string;
  title: string | null;
  status: string;
  kind: string | null;
  createdBy: JobProvenance | null;
  pr: InboxPr | null;
  needsYou: boolean;
  createdAt: string;
}

export function resolveJob(ref: JobRef): Promise<JobDetail> {
  return webJson<JobDetail>(threadPath(ref));
}

/** The manual-block response — every job's live blockers, including the one just added. */
export interface JobDependencyResult {
  ok: boolean;
  blocked: boolean;
  blockers: JobBlocker[];
}

/** Manually block this job on another (the kebab "Block on another job…"). 400s on a disallowed status
 *  (the job is already building or finished) — the client mirrors the same guard to keep the action
 *  disabled ahead of time, but the backend is the source of truth. */
export function addJobDependency(
  ref: JobRef,
  dependsOnJobId: string,
): Promise<JobDependencyResult> {
  return webJson(threadPath(ref, "/dependencies"), {
    method: "POST",
    body: JSON.stringify({ dependsOnJobId }),
  });
}

/** Remove one dependency edge — the kebab "Unblock" clears every current blocker this way (one call per
 *  blocker). */
export function removeJobDependency(
  ref: JobRef,
  dependsOnJobId: string,
): Promise<{ ok: boolean; blockers: JobBlocker[] }> {
  return webJson(
    threadPath(ref, `/dependencies/${encodeURIComponent(dependsOnJobId)}`),
    { method: "DELETE" },
  );
}

// ── Delete ─────────────────────────────────────────────────────────────────────────────────────
export function deleteThread(
  ref: JobRef,
  prAction?: "close" | "leave",
): Promise<{ ok: boolean }> {
  const q = prAction ? `?prAction=${prAction}` : "";
  return webJson(`${threadPath(ref)}${q}`, { method: "DELETE" });
}

// ── Repos (create-job picker + the settings Repos tab) ────────────────────────────────────────
export interface RepoView {
  id: string;
  slug: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
  accessOk: boolean;
  /** When access was last validated (ISO), or null if never checked. */
  accessCheckedAt: string | null;
  /** Threads living on this repo — gates whether it can be disconnected. */
  threadCount: number;
  /** The repo's current onboarding thread id (`kind='onboarding'`), or null if never started. */
  onboardingThreadId: string | null;
  /** When onboarding completed (workspace config live), ISO; null until then — drives "Set up" vs "Re-run". */
  onboardedAt: string | null;
  /** Non-fatal webhook-registration warning (e.g. token lacks the webhook scope), or null when hooks are healthy. */
  webhookWarning: string | null;
  /** Per-repo feature-branch prefix override; null → the neutral built-in default (`feature/`). */
  branchPrefix: string | null;
  /** Repo-level default GitHub merge method used by auto-merge and the manual Merge PR button. */
  defaultAutoMergeMethod: AutoMergeMethod;
  /** Repo-level default: delete the head branch after a successful merge. */
  defaultAutoMergeDeleteBranch: boolean;
}

export function fetchOrgRepos(orgId: string): Promise<RepoView[]> {
  return webJson<RepoView[]>(`/orgs/${orgId}/repos`);
}

export interface RepoBranches {
  branches: string[];
  defaultBranch: string;
}

/** A repo's branches (default first) for the create-job base-branch picker. */
export function fetchRepoBranches(
  orgId: string,
  repoId: string,
): Promise<RepoBranches> {
  return webJson<RepoBranches>(`/orgs/${orgId}/repos/${repoId}/branches`);
}

/** Operator-selectable job kinds (mirrors the backend allowlist; system kinds event/onboarding excluded). */
export type OperatorJobKind = "feature" | "bugfix" | "review";

export interface CreateThreadBody {
  firstMessage: string;
  title?: string;
  baseBranch?: string;
  /** Operator-chosen job kind; omit to let the brain scope it (current default behavior). */
  kind?: OperatorJobKind;
  /** For `kind: "review"` — the PR number to review (seeds a <review> block on the brain's first turn). */
  prNumber?: string;
  /** Arm auto-approve at creation; omit (or "off") to leave the job's gates waiting for a human. */
  autoApproveMode?: AutoApproveMode;
  /** Arm auto-merge at creation; omit/false leaves the job's PR gated for a human. */
  autoMerge?: boolean;
}

export function createJob(
  orgId: string,
  repoId: string,
  body: CreateThreadBody,
): Promise<{ jobId: string }> {
  return webJson(`/orgs/${orgId}/repos/${repoId}/jobs`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Create a job WITH attachments — multipart (`firstMessage`/`title`/`baseBranch` fields + `files` parts). */
export function createJobWithFiles(
  orgId: string,
  repoId: string,
  body: CreateThreadBody,
  files: File[],
): Promise<{ jobId: string }> {
  const form = new FormData();
  form.append("firstMessage", body.firstMessage);
  if (body.title) form.append("title", body.title);
  if (body.baseBranch) form.append("baseBranch", body.baseBranch);
  if (body.kind) form.append("kind", body.kind);
  if (body.prNumber) form.append("prNumber", body.prNumber);
  form.append("autoApproveMode", body.autoApproveMode ?? "off");
  form.append("autoMerge", String(body.autoMerge ?? false));
  for (const f of files) form.append("files", f, f.name);
  return webJson(`/orgs/${orgId}/repos/${repoId}/jobs`, {
    method: "POST",
    body: form,
  });
}
