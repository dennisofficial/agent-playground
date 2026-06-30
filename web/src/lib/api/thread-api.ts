'use client';

import { env } from '@/lib/env';
import { fetchWithRefresh } from './refresh';
import type {
  ApprovalActionId,
  ContextFileContent,
  PipelineJob,
  PipelineState,
  ThreadContext,
  WebCard,
} from './types';

/**
 * The org → repo → thread web API (`/web/orgs/:orgId/repos/:repoId/threads/:threadId/...`). Every call
 * is credentialed (the session cookie authorizes the membership-gated routes) and goes through
 * `fetchWithRefresh` so an expired access cookie is re-upped + retried once. This is the real, current
 * contract — it replaces the dead channel client (`client.ts`).
 */

const BASE = `${env.NEXT_PUBLIC_HTTP_URL}/web`;

/** Everything needed to address one thread. The inbox row (`/web/threads`) carries all three. */
export interface ThreadRef {
  orgId: string;
  repoId: string;
  threadId: string;
}

export class ThreadApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ThreadApiError';
  }
}

async function webJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithRefresh(`${BASE}${path}`, {
    ...init,
    headers: { accept: 'application/json', 'content-type': 'application/json', ...init?.headers },
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

function threadPath(ref: ThreadRef, suffix = ''): string {
  return `/orgs/${ref.orgId}/repos/${ref.repoId}/threads/${ref.threadId}${suffix}`;
}

// ── Messages ───────────────────────────────────────────────────────────────────────────────────
/** The durable message row as the backend returns it (`…/threads/:threadId/messages`). */
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
  source: 'operator' | 'atlas' | 'system_operator' | 'system_shared' | 'system_event';
  card?: WebCard | null;
  meta?: Record<string, unknown> | null;
  postedAt: string;
}

/** UI message shape — normalized so the conversation classifier can read it uniformly. */
export interface ThreadMessage {
  /** Stable key (synthetic monotonic ts; a local optimistic post gets a `local-*` key). */
  ts: string;
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
  source: 'operator' | 'atlas' | 'system_operator' | 'system_shared' | 'system_event';
  card?: WebCard;
  meta?: Record<string, unknown>;
  postedAt: string;
  /** Client-only: an optimistic post not yet echoed by history. */
  local?: boolean;
  /** Client-only: sent while a turn was streaming → queued behind it (rendered distinctly). */
  queued?: boolean;
}

export function normalizeMessage(r: RawThreadMessage): ThreadMessage {
  return {
    ts: r.ts ?? r.id ?? `srv-${r.postedAt}`,
    author: r.isAtlas ? 'atlas' : 'user',
    authorId: r.authorId,
    authorName: r.author,
    text: r.text ?? '',
    kind: r.kind,
    source: r.source,
    card: r.card ?? undefined,
    meta: r.meta ?? undefined,
    postedAt: r.postedAt,
  };
}

export function fetchMessages(ref: ThreadRef): Promise<ThreadMessage[]> {
  return webJson<RawThreadMessage[]>(threadPath(ref, '/messages')).then((rows) =>
    rows.map(normalizeMessage),
  );
}

export function sayMessage(ref: ThreadRef, text: string): Promise<{ ts: string }> {
  return webJson(threadPath(ref, '/say'), { method: 'POST', body: JSON.stringify({ text }) });
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
  ref: ThreadRef,
  body: ApproveBody,
): Promise<{ ok: boolean; jobId?: string }> {
  return webJson(threadPath(ref, '/approve'), { method: 'POST', body: JSON.stringify(body) });
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
  ref: ThreadRef,
  body: AnswerQuestionBody,
): Promise<{ ok: boolean; ts: string }> {
  return webJson(threadPath(ref, '/answer-question'), { method: 'POST', body: JSON.stringify(body) });
}

// ── Secure secret intake (repo onboarding) ─────────────────────────────────────────────────────────
export interface ProvideSecretBody {
  /** The secret card's id (its message ts). */
  requestId: string;
  /** The plaintext value — sent once over HTTPS to the encrypted store; never round-tripped back. */
  value: string;
}

export function provideSecret(
  ref: ThreadRef,
  body: ProvideSecretBody,
): Promise<{ ok: boolean; ts: string }> {
  return webJson(threadPath(ref, '/provide-secret'), { method: 'POST', body: JSON.stringify(body) });
}

/** Re-drive a halted (failed/paused) build — the navigator "Retry" button. No-op if not retryable. */
export function retryThread(ref: ThreadRef): Promise<{ ok: boolean; status: string }> {
  return webJson(threadPath(ref, '/retry'), { method: 'POST' });
}

// ── Pipeline ───────────────────────────────────────────────────────────────────────────────────
export function fetchPipeline(ref: ThreadRef): Promise<PipelineState> {
  return webJson<PipelineState>(threadPath(ref, '/pipeline'));
}

/** Narrow a pipeline read to its job, or `null` before a plan is approved (`{ status: 'no_job' }`). */
export function pipelineJob(state: PipelineState | undefined): PipelineJob | null {
  if (!state || state.status === 'no_job') return null;
  return state;
}

// ── Context (specs + artifacts files) ────────────────────────────────────────────────────────────
/** List the thread's `/context` files, grouped into `specs` (plan) + `artifacts` (outputs). */
export function fetchThreadContext(ref: ThreadRef): Promise<ThreadContext> {
  return webJson<ThreadContext>(threadPath(ref, '/context'));
}

/** Read one `/context` file's content (`path` is bucket-relative, e.g. `specs/plan.md`). */
export function fetchContextFile(ref: ThreadRef, path: string): Promise<ContextFileContent> {
  return webJson<ContextFileContent>(
    threadPath(ref, `/context/file?path=${encodeURIComponent(path)}`),
  );
}

// ── Rename (the only thread Update op) ───────────────────────────────────────────────────────────
export function renameThread(ref: ThreadRef, title: string): Promise<{ ok: boolean; title: string }> {
  return webJson(threadPath(ref), { method: 'PATCH', body: JSON.stringify({ title }) });
}

// ── Delete ─────────────────────────────────────────────────────────────────────────────────────
export function deleteThread(ref: ThreadRef): Promise<{ ok: boolean }> {
  return webJson(threadPath(ref), { method: 'DELETE' });
}

// ── Repos (create-thread picker + the settings Repos tab) ────────────────────────────────────────
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
  /** When onboarding completed (worktree config live), ISO; null until then — drives "Set up" vs "Re-run". */
  onboardedAt: string | null;
}

export function fetchOrgRepos(orgId: string): Promise<RepoView[]> {
  return webJson<RepoView[]>(`/orgs/${orgId}/repos`);
}

export interface RepoBranches {
  branches: string[];
  defaultBranch: string;
}

/** A repo's branches (default first) for the create-thread base-branch picker. */
export function fetchRepoBranches(orgId: string, repoId: string): Promise<RepoBranches> {
  return webJson<RepoBranches>(`/orgs/${orgId}/repos/${repoId}/branches`);
}

export interface CreateThreadBody {
  firstMessage: string;
  title?: string;
  baseBranch?: string;
}

export function createThread(
  orgId: string,
  repoId: string,
  body: CreateThreadBody,
): Promise<{ threadId: string }> {
  return webJson(`/orgs/${orgId}/repos/${repoId}/threads`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
