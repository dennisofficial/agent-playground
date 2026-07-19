'use client';

import type { ReviewComment } from '@/features/job-workspace/components/review/review-comments';
import { env } from '@/lib/env';
import type { AutoApproveMode, AutoMergeMethod, EJobKind, EJobStatus } from '@workspace/shared';
import { notImplemented } from './_stub';
import type {
  ApprovalActionId,
  ContextFileContent,
  InboxPr,
  JobBlocker,
  JobContext,
  JobDiff,
  JobDiffSummary,
  JobProvenance,
  ServiceInfo,
  WebCard,
} from './types';

/**
 * STUB (Atlas rebuild): the org → repo → thread web API (`/web/orgs/:orgId/repos/:repoId/jobs/:jobId/...`)
 * isn't rebuilt yet. The single `webJson` helper below is gutted to throw "Not Implemented", which
 * neutralizes every function here — they keep their real path/return-TYPE signatures (so the hooks that
 * wrap them still infer correctly and render/throw as stubs) but make no network call. This file is kept
 * as the endpoint contract to re-wire against; the types below are the wire shapes.
 */

const BASE = `${env.NEXT_PUBLIC_BACKEND_URL}/web`;

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
    /** Set on a 429 `{status:'cooling_down', retryAfterMs}` body (the manual retry/resume re-slam guard,
     *  `/retry` + `/retry-turn`) — how long the caller should wait before the server will accept another
     *  bare (non-`force`) manual retry for this job. Undefined for every other error shape. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ThreadApiError';
  }
}

/** A mutation's error, unwrapped to a message worth showing the operator — the backend's own 400 text
 *  (e.g. "can't block a job that is already building or finished…") when we have it, else a flat fallback. */
export function mutationErrorMessage(err: unknown, fallback: string): string {
  return err instanceof ThreadApiError ? err.message : fallback;
}

// STUB (Atlas rebuild): the `/web/orgs/:o/repos/:r/jobs/:j/...` thread backend isn't rebuilt yet, so every
// call funnels through here and throws "Not Implemented" instead of hitting the network. This one choke
// point neutralizes all 16 webJson-backed functions below; their path/body plumbing is kept as the live
// contract to re-wire against. Callers pass a `path`; it's echoed into the throw so failures are greppable.
function webJson<T>(path: string, _init?: RequestInit): Promise<T> {
  return notImplemented(`job-api ${path}`);
}

function threadPath(ref: JobRef, suffix = ''): string {
  return `/orgs/${ref.orgId}/repos/${ref.repoId}/jobs/${ref.jobId}${suffix}`;
}

/** The durable message row as the backend returns it (`…/threads/:jobId/messages`). */
export interface RawThreadMessage {
  /** The row's uuid — a stable React key (transcript blocks have no surface `ts`). */
  id?: string;
  /** The owning thread — the web filters a thread's transcript by this (replaces the old `meta.phaseId` peel). */
  threadId: string;
  /** The subagent this block belongs to (a spawned Task tool run), or null for a block that belongs directly
   *  to the thread. Joins the same way `meta.id`/`meta.parentToolUseId` always has — this is an additional,
   *  denormalized cross-check field. */
  subagentId: string | null;
  /** The spawned subagent's AUTHORITATIVE lifecycle status ('running'|'done'|'failed'), present only on the
   *  anchor (Task launching) message. The durable subagent card keys its running/done off this instead of the
   *  launch-ack heuristic. Absent on non-anchor messages and legacy anchors with no subagent row. */
  subagentStatus?: string | null;
  /** ISO end time of the spawned subagent, or null while running; present only on the anchor message. */
  subagentEndedAt?: string | null;
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
    | 'operator'
    | 'atlas'
    | 'system_operator'
    | 'system_shared'
    | 'system_event'
    | 'system_notice'
    | 'system_reminder'
    | 'untrusted';
  card?: WebCard | null;
  /**
   * Untyped per-message extras. On a `system_operator` failure notice: `retryable` (bool, shows the Resume
   * button), `sessionLimit` (bool, shows the countdown + Force-resume row instead), `resumeAt` (ISO string,
   * the session-limit auto-resume clock), and — the classified-failure surfacing — `category`
   * (`TurnFailureCategory`: `session_limit` | `auth` | `transient` | `api_overloaded` | `sandbox_lost` |
   * `unresumable` | `unknown`) + `summary` (a short plain-language headline; when present the box leads with
   * it and tucks the raw `text` behind a "Details" disclosure — see `SystemOperatorNotice`).
   */
  meta?: Record<string, unknown> | null;
  postedAt: string;
  /** The delivery stimulus id stamped once the message row exists server-side, or absent for a row with no
   *  delivery lifecycle. Paired with {@link deliveredAt} to derive the send state (staged/sending/landed). */
  stimulusId?: string;
  /** ISO time the row was actually delivered (taken by the SDK/engine), or absent while still in flight. */
  deliveredAt?: string;
  /** Effective render-order override (transcript_messages.order_at) — set only for mid-turn pure-UI
   *  notices re-stamped at turn end. Absent/null for the common case (falls back to deliveredAt/postedAt). */
  orderAt?: string | null;
}

/** UI message shape — normalized so the conversation classifier can read it uniformly. */
export interface JobMessage {
  /** Stable key (synthetic monotonic ts; a local optimistic post gets a `local-*` key). */
  ts: string;
  /** The owning thread — used to filter a thread's transcript. */
  threadId: string;
  /** The subagent this block belongs to (a spawned Task tool run), or null for a block that belongs directly
   *  to the thread. */
  subagentId: string | null;
  /** The spawned subagent's AUTHORITATIVE lifecycle status ('running'|'done'|'failed'), present only on the
   *  anchor (Task launching) message. The durable subagent card keys running/done off this. */
  subagentStatus?: string | null;
  /** ISO end time of the spawned subagent, or null while running; present only on the anchor message. */
  subagentEndedAt?: string | null;
  /** `atlas` (the agent) or `user` (a human — the operator). Drives bubble alignment. */
  author: 'atlas' | 'user';
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
    | 'operator'
    | 'atlas'
    | 'system_operator'
    | 'system_shared'
    | 'system_event'
    | 'system_notice'
    | 'system_reminder'
    | 'untrusted';
  card?: WebCard;
  /** See {@link RawThreadMessage.meta} — same shape, carried through `normalizeMessage` unchanged. */
  meta?: Record<string, unknown>;
  postedAt: string;
  /** Client-only: an optimistic post not yet echoed by history. */
  local?: boolean;
  /** See {@link RawThreadMessage.stimulusId} — carried through `normalizeMessage` unchanged. */
  stimulusId?: string;
  /** See {@link RawThreadMessage.deliveredAt} — carried through `normalizeMessage` unchanged. */
  deliveredAt?: string;
  /** See {@link RawThreadMessage.orderAt} — carried through `normalizeMessage` unchanged. */
  orderAt?: string | null;
}

export function normalizeMessage(r: RawThreadMessage): JobMessage {
  return {
    ts: r.ts ?? r.id ?? `srv-${r.postedAt}`,
    threadId: r.threadId,
    subagentId: r.subagentId,
    subagentStatus: r.subagentStatus ?? null,
    subagentEndedAt: r.subagentEndedAt ?? null,
    author: r.isAtlas ? 'atlas' : 'user',
    authorId: r.authorId,
    authorName: r.author,
    text: r.text ?? '',
    kind: r.kind,
    source: r.source,
    card: r.card ?? undefined,
    meta: r.meta ?? undefined,
    postedAt: r.postedAt,
    stimulusId: r.stimulusId,
    deliveredAt: r.deliveredAt,
    orderAt: r.orderAt,
  };
}

/** One item in a `/message` send — the wire shape of a `Message` (mirrors the backend's client-originated
 *  `Message` union variants; see `web-surface.controller.ts`'s `MessageInput`). `secret_provided` carries no
 *  kind discriminant — the durable-vs-mcp destination is derived server-side from the card. */
export type MessageInput =
  | { type: 'user'; text: string; lane?: string }
  | { type: 'answer_question'; questionId: string; answer: string }
  | {
      type: 'file_answered';
      requestId: string;
      filename: string;
      content: string;
    }
  | { type: 'secret_provided'; requestId: string; value: string };

/**
 * Send a batch of typed messages in ONE request — replaces the old `say`/`answer-question`/`provide-file`/
 * `answer-batch` endpoints. JSON body when `files` is absent; multipart (`messages` JSON-stringified +
 * repeated `files` parts, binary all the way — no base64) when a `user` item carries attachments.
 */
export function postMessage(
  ref: JobRef,
  messages: MessageInput[],
  files?: File[],
): Promise<{
  ok: boolean;
  ts: string;
  results: Array<{ id: string; status: string }>;
}> {
  if (files?.length) {
    const form = new FormData();
    form.append('messages', JSON.stringify(messages));
    for (const f of files) form.append('files', f, f.name);
    return webJson(threadPath(ref, '/message'), { method: 'POST', body: form });
  }
  return webJson(threadPath(ref, '/message'), {
    method: 'POST',
    body: JSON.stringify({ messages }),
  });
}

/**
 * Fetch a composer attachment as a blob object-URL (for `<img>` thumbnails / file links). Uses a
 * credentialed fetch of the STREAMING raw endpoint — never a base64 data URL — so large images don't
 * bloat memory or block. The caller MUST `URL.revokeObjectURL` the result when done.
 */
export function fetchAttachmentUrl(ref: JobRef, path: string): Promise<string> {
  // STUB (Atlas rebuild): the raw-stream endpoint doesn't flow through `webJson`, so it's gutted here too.
  return notImplemented(`job-api fetchAttachmentUrl ${ref.jobId}:${path}`);
}

// These mirror the backend `composer-draft.service.ts` wire shapes. There is no shared package, so the
// types are kept in sync by hand (the same convention `ReviewComment` already follows).

/** One staged card answer as it rides the draft wire — structurally the client `StagedAnswer` union. The
 *  secret variant's `value` is cleartext on the wire; the server encrypts on PUT and decrypts on GET for
 *  the owner's own devices. */
export type DraftStagedAnswerWire =
  | { kind: 'question'; cardId: string; label: string; answer: string }
  | {
      kind: 'file';
      cardId: string;
      label: string;
      filename: string;
      content: string;
    }
  | { kind: 'secret'; cardId: string; label: string; value: string };

/** The serializable draft body — `PUT .../draft` sends it, `GET .../draft` returns it under `payload`. */
export interface DraftPayloadWire {
  text: string;
  stagedAnswers: DraftStagedAnswerWire[];
  comments: ReviewComment[];
}

/** A server-stored draft attachment (already uploaded), as the draft endpoints return it. No raw bytes. */
export interface DraftAttachmentDto {
  id: string;
  name: string;
  kind: 'image' | 'file';
  size: number;
}

/** Read the caller's own draft for a job. Never creates a row — an absent draft reads as empty. */
export function getDraft(ref: JobRef): Promise<{
  payload: DraftPayloadWire;
  attachments: DraftAttachmentDto[];
  updatedAt: string | null;
}> {
  return webJson(threadPath(ref, '/draft'));
}

/** Debounced autosave — replace the caller's whole draft body (attachments are managed separately). */
export function putDraft(ref: JobRef, payload: DraftPayloadWire): Promise<{ ok: boolean }> {
  return webJson(threadPath(ref, '/draft'), {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

/** Upload one draft attachment (multipart `files`, same caps as a normal attachment). Returns its row. */
export function addDraftAttachment(ref: JobRef, file: File): Promise<DraftAttachmentDto> {
  const form = new FormData();
  form.append('files', file, file.name);
  return webJson<{ attachments: DraftAttachmentDto[] }>(threadPath(ref, '/draft/attachments'), {
    method: 'POST',
    body: form,
  }).then((r) => r.attachments[0]);
}

/** Remove one uploaded draft attachment by id. */
export function deleteDraftAttachment(ref: JobRef, attachmentId: string): Promise<{ ok: boolean }> {
  return webJson(threadPath(ref, `/draft/attachments/${attachmentId}`), {
    method: 'DELETE',
  });
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
    .split('/')
    .filter((seg) => seg.length > 0)
    .map(encodeURIComponent)
    .join('/');
  return `${BASE}${threadPath(ref, `/context/raw/${encoded}`)}`;
}

/**
 * Gracefully stop the thread brain's in-flight turn (the composer's Stop button). Returns `{ stopped }` —
 * `false` if there was no live turn to stop. The backend emits a normal `turn_end` (no separate abort
 * frame), so the live indicator clears through the usual reconcile path.
 */
export function stopJob(ref: JobRef): Promise<{ stopped: boolean }> {
  return webJson(threadPath(ref, '/stop'), { method: 'POST' });
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
  return webJson(threadPath(ref, '/review-comments'), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

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
  return webJson(threadPath(ref, '/approve'), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Ask the build brain to stand up a demo-ready live preview at the ship gate. Injects the full preview
 *  procedure as a server-side seed turn (not the generic /message path) and stamps the ship card so the button
 *  hides. Gated server-side on `awaiting_ship_review`; a no-op `ok:false` off-gate. */
export function spinUpPreview(ref: JobRef): Promise<{ ok: boolean; ts: string }> {
  return webJson(threadPath(ref, '/spin-up-preview'), { method: 'POST' });
}

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
  return webJson(threadPath(ref, '/provide-secret'), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Approve a brain `propose_mcp_servers` card — commits each server on the repo (owner-only on the server). */
export function approveMcpProposal(
  ref: JobRef,
  requestId: string,
): Promise<{ ok: boolean; committed: string[]; ts?: string }> {
  return webJson(threadPath(ref, `/mcp-proposals/${requestId}/approve`), {
    method: 'POST',
  });
}

/** Approve a brain skill proposal — installs (git) / vendors the authored draft / removes, per the card's
 *  mode (owner-only on the server). */
export function approveSkillProposal(
  ref: JobRef,
  requestId: string,
): Promise<{ ok: boolean; name: string; ts?: string }> {
  return webJson(threadPath(ref, `/skill-proposals/${requestId}/approve`), {
    method: 'POST',
  });
}

/** Re-drive a halted (failed/paused) build — the navigator "Retry" button. No-op if not retryable.
 *  `force: true` (the session-limit "Force resume now" affordance) skips the server's short manual-retry
 *  re-slam cooldown — sent as `?force=true`. */
export function retryJob(
  ref: JobRef,
  opts?: { force?: boolean },
): Promise<{ ok: boolean; status: string }> {
  const q = opts?.force ? '?force=true' : '';
  return webJson(threadPath(ref, `/retry${q}`), { method: 'POST' });
}

/** "Ship without review" escape hatch on a `codex_review_unavailable` job hold — marks the ship-time
 *  master_review thread skipped/done and lands the job at the normal ship-review gate (the human PR gate
 *  still applies). Refused server-side unless the job is actually held on a Codex outage. */
export function shipWithoutReview(ref: JobRef): Promise<{ ok: boolean; reason?: string }> {
  return webJson(threadPath(ref, '/ship-without-review'), {
    method: 'POST',
  });
}

/**
 * The "Resume" button on a `retryable` system→operator error box (a chat-turn that hit a transient
 * engine failure). Distinct from `retryJob` — this re-pokes the SAME engine session with no new operator
 * message, rather than re-driving a halted BUILD track. `force: true` (the session-limit "Force resume
 * now" affordance) skips the server's short manual-retry re-slam cooldown — sent as `?force=true`.
 */
export function retryTurn(ref: JobRef, opts?: { force?: boolean }): Promise<{ ok: boolean }> {
  const q = opts?.force ? '?force=true' : '';
  return webJson(threadPath(ref, `/retry-turn${q}`), { method: 'POST' });
}

export function fetchServices(ref: JobRef): Promise<{ services: ServiceInfo[] }> {
  return webJson<{ services: ServiceInfo[] }>(threadPath(ref, '/services'));
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

/** List the thread's `/context` files, grouped into `specs` (plan) + `artifacts` (outputs). */
export function fetchThreadContext(ref: JobRef): Promise<JobContext> {
  return webJson<JobContext>(threadPath(ref, '/context'));
}

/** Read one `/context` file's content (`path` is bucket-relative, e.g. `specs/plan.md`). */
export function fetchContextFile(ref: JobRef, path: string): Promise<ContextFileContent> {
  return webJson<ContextFileContent>(
    threadPath(ref, `/context/file?path=${encodeURIComponent(path)}`),
  );
}

/** The job's accumulated multi-file diff (`GET …/jobs/:jobId/diff`) — the Changes pane's data. */
export function fetchJobDiff(ref: JobRef): Promise<JobDiff> {
  return webJson<JobDiff>(threadPath(ref, '/diff'));
}

/** The job's cheap numstat-only diff summary (`GET …/jobs/:jobId/diff/summary`) — no hunks, just per-file
 *  path/additions/deletions/status/binary. Used by the always-mounted sidebar for its +/- totals so it
 *  never has to hold the heavy full-diff query open. */
export function fetchJobDiffSummary(ref: JobRef): Promise<JobDiffSummary> {
  return webJson<JobDiffSummary>(threadPath(ref, '/diff/summary'));
}

/** The job worktree's TRACKED-file manifest (git ls-files) — used to verify which inline-code spans name a
 *  real repo file before linkifying them. Empty when the worktree is gone (closed/reset). */
export function fetchRepoTree(ref: JobRef): Promise<{ files: string[] }> {
  return webJson<{ files: string[] }>(threadPath(ref, '/repo/tree'));
}

/** Read one repo file from the LIVE job worktree by git-relative path (tracked files only; 404 otherwise). */
export function fetchRepoFile(ref: JobRef, path: string): Promise<ContextFileContent> {
  return webJson<ContextFileContent>(
    threadPath(ref, `/repo/file?path=${encodeURIComponent(path)}`),
  );
}

export function renameJob(ref: JobRef, title: string): Promise<{ ok: boolean; title: string }> {
  return webJson(threadPath(ref), {
    method: 'PATCH',
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
  return webJson(threadPath(ref, '/auto-approve'), {
    method: 'PATCH',
    body: JSON.stringify({ mode }),
  });
}

/** Set the job's per-job auto-merge settings (`PATCH …/jobs/:jobId/auto-merge`). Enabling on an already
 *  merge-ready PR immediately evaluates/merges (backend). */
export function setAutoMerge(
  ref: JobRef,
  body: { autoMerge: boolean },
): Promise<{ ok: boolean; autoMerge: boolean }> {
  return webJson(threadPath(ref, '/auto-merge'), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/** A child job spawned FROM this one (`GET …/jobs/:jobId/created`) — the "Created jobs" navigator row +
 *  detail pane. */
export interface CreatedJobRow {
  id: string;
  title: string | null;
  status: EJobStatus;
  kind: EJobKind | null;
  prState: string | null;
  needsYou: boolean;
  createdAt: string;
}

export function fetchCreatedJobs(ref: JobRef): Promise<CreatedJobRow[]> {
  return webJson<CreatedJobRow[]>(threadPath(ref, '/created'));
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
  return webJson(threadPath(ref, '/dependencies'), {
    method: 'POST',
    body: JSON.stringify({ dependsOnJobId }),
  });
}

/** Remove one dependency edge — the kebab "Unblock" clears every current blocker this way (one call per
 *  blocker). */
export function removeJobDependency(
  ref: JobRef,
  dependsOnJobId: string,
): Promise<{ ok: boolean; blockers: JobBlocker[] }> {
  return webJson(threadPath(ref, `/dependencies/${encodeURIComponent(dependsOnJobId)}`), {
    method: 'DELETE',
  });
}

export function deleteThread(ref: JobRef, prAction?: 'close' | 'leave'): Promise<{ ok: boolean }> {
  const q = prAction ? `?prAction=${prAction}` : '';
  return webJson(`${threadPath(ref)}${q}`, { method: 'DELETE' });
}

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
export function fetchRepoBranches(orgId: string, repoId: string): Promise<RepoBranches> {
  return webJson<RepoBranches>(`/orgs/${orgId}/repos/${repoId}/branches`);
}

/** Operator-selectable job kinds (mirrors the backend allowlist; system kinds event/onboarding excluded). */
export type OperatorJobKind = 'feature' | 'bugfix' | 'review';

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
  /** Job ids this new job should block on (born-blocked). All must be siblings in the same repo.
   *  When any is still live, the job starts blocked and its first turn/branch are deferred until they resolve. */
  dependsOn?: string | string[];
}

export function createJob(
  orgId: string,
  repoId: string,
  body: CreateThreadBody,
): Promise<{ jobId: string }> {
  return webJson(`/orgs/${orgId}/repos/${repoId}/jobs`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function dependsOnList(dependsOn: CreateThreadBody['dependsOn']): string[] {
  if (dependsOn == null) return [];
  return Array.isArray(dependsOn) ? dependsOn : [dependsOn];
}

/** Create a job WITH attachments — multipart (`firstMessage`/`title`/`baseBranch` fields + `files` parts). */
export function createJobWithFiles(
  orgId: string,
  repoId: string,
  body: CreateThreadBody,
  files: File[],
): Promise<{ jobId: string }> {
  const form = new FormData();
  form.append('firstMessage', body.firstMessage);
  if (body.title) form.append('title', body.title);
  if (body.baseBranch) form.append('baseBranch', body.baseBranch);
  if (body.kind) form.append('kind', body.kind);
  if (body.prNumber) form.append('prNumber', body.prNumber);
  form.append('autoApproveMode', body.autoApproveMode ?? 'off');
  form.append('autoMerge', String(body.autoMerge ?? false));
  for (const id of dependsOnList(body.dependsOn)) form.append('dependsOn', id);
  for (const f of files) form.append('files', f, f.name);
  return webJson(`/orgs/${orgId}/repos/${repoId}/jobs`, {
    method: 'POST',
    body: form,
  });
}
