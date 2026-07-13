import { Injectable } from '@nestjs/common';
import type { AutoMergeMethod } from '@workspace/shared';

/**
 * Atlas v2's minimal GitHub REST client — a clean-room rewrite of v1's `GithubApiService`, scoped to
 * the PR/repo concerns W1 needs (open/find a PR, mark ready, probe a repo). Zero dependencies (global
 * `fetch`); `fetchImpl` is the spec seam. The token rides in the Authorization header per request —
 * errors carry GitHub's status + message but NEVER the token.
 */

const API = 'https://api.github.com';

/** A conditionalGet status that carries a usable body: a 2xx, or a 304 (cached body returned). */
function isOkStatus(status: number): boolean {
  return status === 304 || (status >= 200 && status < 300);
}

/** Events delivered to the WORK-EVENTS front door (`/webhooks/github/events`) → routed to the owning job. */
export const WORK_EVENTS = [
  'workflow_run',
  'check_run',
  'check_suite',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
];
/**
 * Events delivered to the silent PR-state-sync front door (`/webhooks/github/state`). `pull_request`
 * drives the open/merge/close sync; `push` drives the real-time base-move-conflict unlock — a push to a
 * repo's DEFAULT branch marks that repo's open PRs due-now so the reconciler re-checks mergeability in
 * seconds (GitHub emits no webhook for a base-induced conflict).
 */
export const STATE_EVENTS = ['pull_request', 'push'];

export interface OpenPullRequestArgs {
  owner: string;
  repo: string;
  /** The PR's source (feature) branch. */
  head: string;
  /** The PR's target branch (the project's default branch). */
  base: string;
  title: string;
  body?: string;
  /** Open as a DRAFT PR (in-progress work). */
  draft?: boolean;
}

export interface PullRequestResult {
  url: string;
  number: number;
  /** True when an open PR for this head already existed and was returned instead. */
  existing: boolean;
}

/** One-request PR snapshot the reconciler polls (state + computed mergeability + head for CI). */
export interface PullDetail {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed' | 'gone';
  /**
   * GitHub's computed `mergeable_state` — `clean | dirty | behind | blocked | unstable | has_hooks |
   * draft | unknown`, or `null` while GitHub is still computing it (treat null as "unknown", retry).
   * `dirty` = merge conflict against the base.
   */
  mergeableState: string | null;
  headSha: string | null;
  headRef: string | null;
}

/** A single CI check-run for a commit (from the check-runs API). */
export interface CheckRun {
  id: number;
  name: string;
  /** `queued | in_progress | completed`. */
  status: string;
  /** `success | failure | neutral | cancelled | timed_out | action_required | skipped | null` (null until completed). */
  conclusion: string | null;
  detailsUrl: string | null;
}

/** Per-category CI check counts for a PR head. Sum of the four categories === total. */
export type CiCounts = { failing: number; pending: number; passed: number; skipped: number; total: number };
/** The rolled-up CI summary: overall status + counts (both null when no checks reported). */
export type CiSummary = { status: 'failure' | 'pending' | 'success' | 'skipped' | null; counts: CiCounts | null };

/** A submitted PR review (approve / request-changes / comment). */
export interface PullReview {
  id: number;
  author: string | null;
  /** `APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED`. */
  state: string;
  body: string | null;
  submittedAt: string | null;
  url: string | null;
}

/** The outcome of a merge attempt — `ok` carries the merge commit sha; the failure reasons distinguish the
 *  GitHub statuses the auto-merge evaluator branches on (a moved head vs. a genuinely unmergeable PR). */
export type MergeResult =
  | { ok: true; sha: string }
  | {
      ok: false;
      reason:
        | 'not_mergeable'
        | 'sha_mismatch'
        | 'already_merged'
        | 'method_disallowed'
        | 'other';
      status: number;
      message: string;
    };

export interface RepoInfo {
  fullName: string;
  owner: string;
  name: string;
  /** The HTTPS clone/registry URL. */
  htmlUrl: string;
  defaultBranch: string;
  private: boolean;
  description: string | null;
}

/** Parse `https://github.com/<owner>/<repo>` into parts (drops any `.git`). null if it isn't one. */
export function parseGithubRepoUrl(
  url: string,
): { owner: string; repo: string } | null {
  const m = url
    .trim()
    .match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * Thrown when a GET is short-circuited because the client is paused on a GitHub rate-limit (primary or
 * secondary). Distinct from an ordinary permission/HTTP error so callers can leave the job DUE and resume
 * once the pause clears, rather than treating it as a hard failure.
 */
export class RateLimitedError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

/**
 * Map GraphQL `mergeStateStatus` (`CLEAN|DIRTY|BEHIND|BLOCKED|UNSTABLE|HAS_HOOKS|DRAFT|UNKNOWN`) to the
 * lowercase REST `mergeable_state` vocabulary the `pr_mergeable` column stores. Anything unrecognised (or
 * null/undefined) collapses to `'unknown'`.
 */
export function mapMergeStateStatus(status: string | null | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case 'clean':
      return 'clean';
    case 'dirty':
      return 'dirty';
    case 'behind':
      return 'behind';
    case 'blocked':
      return 'blocked';
    case 'unstable':
      return 'unstable';
    case 'has_hooks':
      return 'has_hooks';
    case 'draft':
      return 'draft';
    default:
      return 'unknown';
  }
}

@Injectable()
export class GithubPrService {
  fetchImpl: typeof fetch = fetch;

  /** Bounded insertion-order Map used as an LRU of `url → { etag, body }` for conditional GETs. */
  private readonly etagCache = new Map<
    string,
    { etag: string; body: unknown }
  >();
  private static readonly MAX_ETAG_ENTRIES = 2000;

  /** REST rate-limit state (independent of the GraphQL budget below). */
  private pausedUntil: number | null = null;
  private consecutivePauses = 0;

  /** GraphQL rate-limit state — a SEPARATE budget from REST, so neither pause affects the other. */
  private graphqlPausedUntil: number | null = null;
  private graphqlConsecutivePauses = 0;

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'atlas', // GitHub rejects UA-less requests
      'Content-Type': 'application/json',
    };
  }

  /** True while the REST client is paused on a rate-limit; poll loops skip until it clears. */
  isRateLimited(): boolean {
    return this.pausedUntil != null && this.pausedUntil > Date.now();
  }

  /** True while the GraphQL client is paused on its own (separate) rate-limit budget. */
  isGraphqlRateLimited(): boolean {
    return (
      this.graphqlPausedUntil != null && this.graphqlPausedUntil > Date.now()
    );
  }

  /** Bump a cache entry's recency (insertion-order Map LRU) after a read hit. */
  private touchLru(url: string): void {
    const hit = this.etagCache.get(url);
    if (!hit) return;
    this.etagCache.delete(url);
    this.etagCache.set(url, hit);
  }

  /** Store/refresh an entry, evicting the oldest when past the cap. */
  private storeLru(url: string, etag: string, body: unknown): void {
    this.etagCache.delete(url);
    this.etagCache.set(url, { etag, body });
    if (this.etagCache.size > GithubPrService.MAX_ETAG_ENTRIES) {
      const oldest = this.etagCache.keys().next().value;
      if (oldest !== undefined) this.etagCache.delete(oldest);
    }
  }

  /** Read one response header defensively — the spec's fake fetch omits `headers` entirely. */
  private header(res: unknown, name: string): string | null {
    const r = res as { headers?: { get?: (n: string) => string | null } };
    return r.headers?.get?.(name) ?? null;
  }

  private numericHeader(res: unknown, name: string): number | null {
    const raw = this.header(res, name);
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  /** Classify a rate-limit hit from a 403/429 response — primary (remaining 0), explicit retry, or message. */
  private isRateLimitResponse(
    remaining: number | null,
    retryAfterMs: number | null,
    body?: { message?: string },
  ): boolean {
    return (
      remaining === 0 ||
      retryAfterMs != null ||
      /secondary rate limit|rate limit|abuse detection/i.test(
        body?.message ?? '',
      )
    );
  }

  /** Exponential backoff (60s, 120s, … capped ~16min) for the Nth consecutive pause. */
  private backoffMs(consecutivePauses: number): number {
    return 60_000 * 2 ** Math.min(consecutivePauses, 4);
  }

  /**
   * Read GitHub's rate-limit headers off a REST response and update the REST pause state. A 2xx with a
   * `remaining` count clears any stale pause; a 403/429 classified as a rate limit sets `pausedUntil`.
   */
  private captureRateLimit(res: unknown, body?: { message?: string }): void {
    const now = Date.now();
    const remaining = this.numericHeader(res, 'x-ratelimit-remaining');
    const resetSec = this.numericHeader(res, 'x-ratelimit-reset');
    const retryAfterSec = this.numericHeader(res, 'retry-after');
    const resetMs = resetSec != null ? resetSec * 1000 : null;
    const retryAfterMs = retryAfterSec != null ? retryAfterSec * 1000 : null;
    const status = (res as { status?: number }).status ?? 0;

    if (remaining === 0) {
      this.pausedUntil = Math.max(
        resetMs ?? 0,
        retryAfterMs != null ? now + retryAfterMs : 0,
        now + this.backoffMs(this.consecutivePauses++),
      );
      return;
    }
    if (status >= 200 && status < 300 && remaining != null) {
      this.consecutivePauses = 0;
      this.pausedUntil = null;
      return;
    }
    if (status !== 403 && status !== 429) return;
    if (!this.isRateLimitResponse(remaining, retryAfterMs, body)) return;
    this.pausedUntil = Math.max(
      resetMs ?? 0,
      retryAfterMs != null ? now + retryAfterMs : 0,
      now + this.backoffMs(this.consecutivePauses++),
    );
  }

  /** GraphQL sibling of {@link captureRateLimit} — writes the SEPARATE GraphQL pause state. */
  private captureGraphqlRateLimit(
    res: unknown,
    json?: { errors?: Array<{ message?: string }> },
  ): void {
    const now = Date.now();
    const remaining = this.numericHeader(res, 'x-ratelimit-remaining');
    const resetSec = this.numericHeader(res, 'x-ratelimit-reset');
    const retryAfterSec = this.numericHeader(res, 'retry-after');
    const resetMs = resetSec != null ? resetSec * 1000 : null;
    const retryAfterMs = retryAfterSec != null ? retryAfterSec * 1000 : null;
    const status = (res as { status?: number }).status ?? 0;
    const errorMessage = (json?.errors ?? [])
      .map((e) => e.message)
      .filter(Boolean)
      .join('; ');
    const errorRateLimited = /rate limit|RATE_LIMITED|abuse detection/i.test(
      errorMessage,
    );

    if (remaining === 0) {
      this.graphqlPausedUntil = Math.max(
        resetMs ?? 0,
        retryAfterMs != null ? now + retryAfterMs : 0,
        now + this.backoffMs(this.graphqlConsecutivePauses++),
      );
      return;
    }
    if (
      status >= 200 &&
      status < 300 &&
      remaining != null &&
      !errorRateLimited
    ) {
      this.graphqlConsecutivePauses = 0;
      this.graphqlPausedUntil = null;
      return;
    }
    const httpRateLimited =
      (status === 403 || status === 429) &&
      this.isRateLimitResponse(remaining, retryAfterMs, {
        message: errorMessage,
      });
    if (!httpRateLimited && !errorRateLimited) return;
    this.graphqlPausedUntil = Math.max(
      resetMs ?? 0,
      retryAfterMs != null ? now + retryAfterMs : 0,
      now + this.backoffMs(this.graphqlConsecutivePauses++),
    );
  }

  /**
   * Shared conditional GET for the four poll GETs: sends `If-None-Match` when a body is cached, returns the
   * cached body FREE on a 304, and threads rate-limit state through {@link captureRateLimit}. Short-circuits
   * (cache or {@link RateLimitedError}) without a fetch while paused. The caller still interprets `status`
   * (404, non-OK) and `body` exactly as it interpreted the raw response before.
   */
  private async conditionalGet<T>(
    url: string,
    token: string,
  ): Promise<{ status: number; body: T }> {
    if (this.isRateLimited()) {
      const hit = this.etagCache.get(url);
      if (hit) return { status: 304, body: hit.body as T };
      throw new RateLimitedError(
        `GitHub rate-limited until ${new Date(this.pausedUntil!).toISOString()}`,
      );
    }
    const cached = this.etagCache.get(url);
    const headers = {
      ...this.headers(token),
      ...(cached ? { 'If-None-Match': cached.etag } : {}),
    };
    const res = await this.fetchImpl(url, { headers });
    if (res.status === 304 && cached) {
      this.captureRateLimit(res);
      this.touchLru(url);
      return { status: 304, body: cached.body as T };
    }
    const body = (await res.json().catch(() => ({}))) as T;
    this.captureRateLimit(res, body as { message?: string });
    const etag = this.header(res, 'etag');
    if (res.status >= 200 && res.status < 300 && etag) {
      this.storeLru(url, etag, body);
    }
    return { status: res.status, body };
  }

  /** The GitHub account that owns `token` (GET /user) — for commit attribution. null on any non-OK. */
  async getAuthenticatedUser(
    token: string,
  ): Promise<{ login: string; id: number; name: string | null } | null> {
    const res = await this.fetchImpl(`${API}/user`, {
      headers: this.headers(token),
    });
    if (!res.ok) return null;
    const u = (await res.json()) as {
      login: string;
      id: number;
      name: string | null;
    };
    return { login: u.login, id: u.id, name: u.name ?? null };
  }

  /** Create the PR, or return the already-open one for the same head (idempotent). */
  async openPullRequest(
    token: string,
    args: OpenPullRequestArgs,
  ): Promise<PullRequestResult> {
    const { owner, repo, head, base, title, body, draft } = args;
    const res = await this.fetchImpl(`${API}/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({
        title,
        head,
        base,
        ...(body ? { body } : {}),
        ...(draft ? { draft: true } : {}),
      }),
    });
    if (res.ok) {
      const pr = (await res.json()) as { html_url: string; number: number };
      return { url: pr.html_url, number: pr.number, existing: false };
    }
    const errBody = (await res.json().catch(() => ({}))) as {
      message?: string;
      errors?: Array<{ message?: string }>;
    };
    const detail = [
      errBody.message,
      ...(errBody.errors ?? []).map((e) => e.message),
    ]
      .filter(Boolean)
      .join('; ');
    // 422 "A pull request already exists for <owner>:<head>" → find and return it.
    if (res.status === 422 && /already exists/i.test(detail)) {
      const list = await this.fetchImpl(
        `${API}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(
          `${owner}:${head}`,
        )}&base=${encodeURIComponent(base)}&state=open`,
        { headers: this.headers(token) },
      );
      if (list.ok) {
        const prs = (await list.json()) as Array<{
          html_url: string;
          number: number;
        }>;
        if (prs[0])
          return {
            url: prs[0].html_url,
            number: prs[0].number,
            existing: true,
          };
      }
    }
    throw new Error(
      `GitHub refused the pull request (${res.status}): ${detail || 'no detail'}`,
    );
  }

  /**
   * Flip a DRAFT PR to ready-for-review. GitHub exposes this ONLY via the GraphQL
   * `markPullRequestReadyForReview` mutation, which needs the PR's node id, so we fetch it over REST
   * first. Returns the resulting draft flag (false on success).
   */
  async markReadyForReview(
    token: string,
    { owner, repo, number }: { owner: string; repo: string; number: number },
  ): Promise<{ isDraft: boolean }> {
    const get = await this.fetchImpl(
      `${API}/repos/${owner}/${repo}/pulls/${number}`,
      {
        headers: this.headers(token),
      },
    );
    if (!get.ok)
      throw new Error(`GitHub couldn't load PR #${number} (${get.status})`);
    const { node_id: nodeId } = (await get.json()) as { node_id: string };
    const res = await this.fetchImpl(`${API}/graphql`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({
        query:
          'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
        variables: { id: nodeId },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      data?: {
        markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } };
      };
      errors?: Array<{ message?: string }>;
    };
    if (!res.ok || json.errors?.length) {
      throw new Error(
        `GitHub refused mark-ready for PR #${number} (${res.status}): ${
          json.errors
            ?.map((e) => e.message)
            .filter(Boolean)
            .join('; ') || 'no detail'
        }`,
      );
    }
    return {
      isDraft:
        json.data?.markPullRequestReadyForReview?.pullRequest?.isDraft ?? false,
    };
  }

  /** Close an OPEN PR without merging (PATCH state=closed). Throws with GitHub status+detail on failure. */
  async closePullRequest(
    token: string,
    { owner, repo, number }: { owner: string; repo: string; number: number },
  ): Promise<void> {
    const res = await this.fetchImpl(
      `${API}/repos/${owner}/${repo}/pulls/${number}`,
      {
        method: 'PATCH',
        headers: this.headers(token),
        body: JSON.stringify({ state: 'closed' }),
      },
    );
    if (res.ok) return;
    const errBody = (await res.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(
      `GitHub refused to close PR #${number} (${res.status}): ${errBody.message ?? 'no detail'}`,
    );
  }

  /**
   * Merge an open PR (PUT /pulls/:n/merge) with the repo-configured strategy. `sha` (the validated head)
   * guards against a moved head — GitHub 409s if HEAD advanced past it since the caller last checked.
   */
  async mergePullRequest(
    token: string,
    {
      owner,
      repo,
      number,
      method,
      sha,
    }: { owner: string; repo: string; number: number; method: AutoMergeMethod; sha?: string },
  ): Promise<MergeResult> {
    const res = await this.fetchImpl(
      `${API}/repos/${owner}/${repo}/pulls/${number}/merge`,
      {
        method: 'PUT',
        headers: this.headers(token),
        body: JSON.stringify({
          merge_method: method,
          ...(sha ? { sha } : {}),
        }),
      },
    );
    if (res.ok) {
      const b = (await res.json().catch(() => ({}))) as { sha?: string };
      return { ok: true, sha: b.sha ?? '' };
    }
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    const message = body.message ?? 'no detail';
    // 405 = not mergeable (behind/blocked, OR already merged); 409 = head SHA mismatch; 422 = method disallowed.
    let reason: Exclude<MergeResult, { ok: true }>['reason'] = 'other';
    if (res.status === 409) reason = 'sha_mismatch';
    else if (res.status === 422) reason = 'method_disallowed';
    else if (res.status === 405) {
      reason = /already merged/i.test(message) ? 'already_merged' : 'not_mergeable';
    }
    return { ok: false, reason, status: res.status, message };
  }

  /** Delete a head branch after a merge (DELETE /git/refs/heads/:branch). Best-effort: a 404/422 means
   *  it's already gone (a prior attempt, or GitHub's own auto-delete setting), which is a success here. */
  async deleteBranch(
    token: string,
    { owner, repo, branch }: { owner: string; repo: string; branch: string },
  ): Promise<void> {
    const res = await this.fetchImpl(
      `${API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
      { method: 'DELETE', headers: this.headers(token) },
    );
    if (res.ok || res.status === 404 || res.status === 422) return;
    const errBody = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(
      `GitHub refused to delete branch ${branch} (${res.status}): ${errBody.message ?? 'no detail'}`,
    );
  }

  /** Post a comment on a PR (PRs are issues for the comments API). Best-effort by the caller. */
  async commentOnPullRequest(
    token: string,
    {
      owner,
      repo,
      number,
      body,
    }: { owner: string; repo: string; number: number; body: string },
  ): Promise<void> {
    const res = await this.fetchImpl(
      `${API}/repos/${owner}/${repo}/issues/${number}/comments`,
      {
        method: 'POST',
        headers: this.headers(token),
        body: JSON.stringify({ body }),
      },
    );
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(
        `GitHub refused the PR comment (${res.status}): ${errBody.message ?? 'no detail'}`,
      );
    }
  }

  /**
   * The current state of a PR: `open`, `merged`, or `closed` (closed-unmerged). Used by the thread
   * cleanup poll to detect a finished PR and tear the thread's sandbox down. Returns `gone` on 404
   * (PR/repo deleted) so the caller can clean up too.
   */
  async getPullState(
    token: string,
    { owner, repo, number }: { owner: string; repo: string; number: number },
  ): Promise<'open' | 'merged' | 'closed' | 'gone'> {
    const { status, body } = await this.conditionalGet<{
      state: 'open' | 'closed';
      merged?: boolean;
      merged_at?: string | null;
      message?: string;
    }>(`${API}/repos/${owner}/${repo}/pulls/${number}`, token);
    if (status === 404) return 'gone';
    if (!isOkStatus(status)) {
      throw new Error(
        `GitHub couldn't load PR #${number} (${status}): ${body.message ?? 'no detail'}`,
      );
    }
    if (body.merged || body.merged_at) return 'merged';
    return body.state;
  }

  /**
   * Find the OPEN PR whose head is `<owner>:<head>` — PR DISCOVERY for the reconciler, so a PR opened
   * in-sandbox by Atlas (not by the host) is picked up and recorded on the job. null when none is open.
   */
  async findOpenPullByHead(
    token: string,
    { owner, repo, head }: { owner: string; repo: string; head: string },
  ): Promise<{ url: string; number: number } | null> {
    const { status, body } = await this.conditionalGet<
      Array<{ html_url: string; number: number }>
    >(
      `${API}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open`,
      token,
    );
    if (!isOkStatus(status)) return null;
    const prs = body;
    return prs[0] ? { url: prs[0].html_url, number: prs[0].number } : null;
  }

  /**
   * The full PR detail the reconciler needs in ONE request: lifecycle state, GitHub's computed
   * `mergeable_state` (drives the merge-conflict signal — transiently `null` while GitHub recomputes,
   * so the caller must treat null as "not yet known", not "clean"), and the head branch + SHA (for CI
   * correlation). `state:'gone'` on 404.
   */
  async getPullDetail(
    token: string,
    { owner, repo, number }: { owner: string; repo: string; number: number },
  ): Promise<PullDetail> {
    const { status, body } = await this.conditionalGet<{
      html_url: string;
      number: number;
      state: 'open' | 'closed';
      merged?: boolean;
      merged_at?: string | null;
      mergeable_state?: string | null;
      head?: { sha?: string; ref?: string };
      message?: string;
    }>(`${API}/repos/${owner}/${repo}/pulls/${number}`, token);
    if (status === 404) {
      return {
        number,
        url: '',
        state: 'gone',
        mergeableState: null,
        headSha: null,
        headRef: null,
      };
    }
    if (!isOkStatus(status)) {
      throw new Error(
        `GitHub couldn't load PR #${number} (${status}): ${body.message ?? 'no detail'}`,
      );
    }
    const pr = body;
    const state = pr.merged || pr.merged_at ? 'merged' : pr.state;
    return {
      number: pr.number,
      url: pr.html_url,
      state,
      mergeableState: pr.mergeable_state ?? null,
      headSha: pr.head?.sha ?? null,
      headRef: pr.head?.ref ?? null,
    };
  }

  /**
   * List the check-runs for a commit SHA (or branch/ref) — the reconciler aggregates these into a CI
   * status and routes a harness event to the brain when any run FAILS. Capped at 100 (one page is
   * plenty for a PR head). Returns `[]` on 404 (no checks / SHA gone).
   */
  async listCheckRuns(
    token: string,
    { owner, repo, ref }: { owner: string; repo: string; ref: string },
  ): Promise<CheckRun[]> {
    const { status, body } = await this.conditionalGet<{
      check_runs?: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        details_url?: string | null;
        html_url?: string | null;
      }>;
      message?: string;
    }>(
      `${API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
      token,
    );
    if (status === 404) return [];
    if (!isOkStatus(status)) {
      throw new Error(
        `GitHub couldn't list check-runs for ${owner}/${repo}@${ref} (${status}): ${body.message ?? 'no detail'}`,
      );
    }
    const json = body;
    return (json.check_runs ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      detailsUrl: c.details_url ?? c.html_url ?? null,
    }));
  }

  /**
   * List a PR's submitted reviews (APPROVE / REQUEST_CHANGES / COMMENT with a body) — the poll backstop
   * for review feedback that the webhook may have missed. The reconciler routes new ones to the brain.
   * Capped at 100.
   */
  async listPullReviews(
    token: string,
    { owner, repo, number }: { owner: string; repo: string; number: number },
  ): Promise<PullReview[]> {
    const res = await this.fetchImpl(
      `${API}/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`,
      { headers: this.headers(token) },
    );
    if (res.status === 404) return [];
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(
        `GitHub couldn't list reviews for ${owner}/${repo}#${number} (${res.status}): ${errBody.message ?? 'no detail'}`,
      );
    }
    const json = (await res.json()) as Array<{
      id: number;
      user?: { login?: string };
      state?: string;
      body?: string | null;
      submitted_at?: string | null;
      html_url?: string | null;
    }>;
    return json.map((r) => ({
      id: r.id,
      author: r.user?.login ?? null,
      state: r.state ?? 'COMMENTED',
      body: r.body ?? null,
      submittedAt: r.submitted_at ?? null,
      url: r.html_url ?? null,
    }));
  }

  /**
   * List a repo's branch names with the token — feeds the create-job base-branch picker. Paginated
   * (100/page) and capped so a repo with thousands of branches can't run the request away. Returns the
   * names in GitHub's order (the caller surfaces the default branch first); throws on a non-OK response.
   */
  async listBranches(
    token: string,
    owner: string,
    repo: string,
  ): Promise<string[]> {
    const PER_PAGE = 100;
    const MAX_PAGES = 10; // cap at 1000 branches
    const names: string[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.fetchImpl(
        `${API}/repos/${owner}/${repo}/branches?per_page=${PER_PAGE}&page=${page}`,
        { headers: this.headers(token) },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(
          `GitHub couldn't list branches for ${owner}/${repo} (${res.status}): ${errBody.message ?? 'no detail'}`,
        );
      }
      const batch = (await res.json()) as Array<{ name: string }>;
      names.push(...batch.map((b) => b.name));
      if (batch.length < PER_PAGE) break;
    }
    return names;
  }

  /** Fetch one repo the token can see — the registration probe. null on 404/403; throws otherwise. */
  async getRepo(
    token: string,
    owner: string,
    repo: string,
  ): Promise<RepoInfo | null> {
    const res = await this.fetchImpl(`${API}/repos/${owner}/${repo}`, {
      headers: this.headers(token),
    });
    if (res.ok) {
      const r = (await res.json()) as {
        full_name: string;
        owner: { login: string };
        name: string;
        html_url: string;
        default_branch: string;
        private: boolean;
        description: string | null;
      };
      return {
        fullName: r.full_name,
        owner: r.owner.login,
        name: r.name,
        htmlUrl: r.html_url,
        defaultBranch: r.default_branch,
        private: r.private,
        description: r.description ?? null,
      };
    }
    if (res.status === 404 || res.status === 403) return null;
    const errBody = (await res.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(
      `GitHub couldn't load ${owner}/${repo} (${res.status}): ${errBody.message ?? 'no detail'}`,
    );
  }

  /**
   * Idempotently ensure ONE webhook (identified by its `config.url`) exists on the repo with the given
   * secret + event set. Returns 'created' | 'updated' | 'no-scope' (PAT lacks admin:repo_hook) | 'error'.
   * An existing hook is ALWAYS re-PATCHed rather than skipped: GitHub never returns the stored
   * `config.secret`, so we cannot detect secret drift (a rotated GITHUB_WEBHOOK_SECRET, or a stale manual
   * hook) — unconditionally re-setting the full config guarantees the hook's secret matches
   * verifyGithubSignature. PATCH is idempotent + cheap.
   */
  async ensureWebhook(
    token: string,
    args: {
      owner: string;
      repo: string;
      url: string;
      secret: string;
      events: string[];
    },
  ): Promise<'created' | 'updated' | 'no-scope' | 'error'> {
    const list = await this.fetchImpl(
      `${API}/repos/${args.owner}/${args.repo}/hooks`,
      {
        headers: this.headers(token),
      },
    );
    if (list.status === 403 || list.status === 404) return 'no-scope';
    if (!list.ok) return 'error';
    const hooks = (await list.json()) as Array<{
      id: number;
      config?: { url?: string };
    }>;
    const mine = hooks.find((h) => h.config?.url === args.url);
    const body = {
      config: {
        url: args.url,
        content_type: 'json',
        secret: args.secret,
        insecure_ssl: '0',
      },
      events: args.events,
      active: true,
    };
    if (mine) {
      const patch = await this.fetchImpl(
        `${API}/repos/${args.owner}/${args.repo}/hooks/${mine.id}`,
        {
          method: 'PATCH',
          headers: this.headers(token),
          body: JSON.stringify(body),
        },
      );
      if (patch.status === 403 || patch.status === 404) return 'no-scope';
      return patch.ok ? 'updated' : 'error';
    }
    const created = await this.fetchImpl(
      `${API}/repos/${args.owner}/${args.repo}/hooks`,
      {
        method: 'POST',
        headers: this.headers(token),
        body: JSON.stringify(body),
      },
    );
    if (created.status === 403 || created.status === 404) return 'no-scope';
    return created.ok ? 'created' : 'error';
  }

  /**
   * Delete any Atlas-owned webhooks on the repo that point at OUR backend (`urlPrefix`) but are NOT in
   * `keepUrls` — the migration/prune that removes hooks at RENAMED or retired URLs (e.g. the old
   * `/ingress/github` + `/webhooks/github` doors after the rename to `/webhooks/github/{events,state}`).
   * Scoped to `urlPrefix` so third-party hooks (Vercel, Slack, …) are never touched. Idempotent + best
   * effort: returns the count deleted; a lack of `admin:repo_hook` (403/404) is a silent no-op.
   */
  async pruneWebhooksExcept(
    token: string,
    args: {
      owner: string;
      repo: string;
      urlPrefix: string;
      keepUrls: string[];
    },
  ): Promise<number> {
    const list = await this.fetchImpl(
      `${API}/repos/${args.owner}/${args.repo}/hooks`,
      { headers: this.headers(token) },
    );
    if (!list.ok) return 0;
    const hooks = (await list.json()) as Array<{
      id: number;
      config?: { url?: string };
    }>;
    const keep = new Set(args.keepUrls);
    const stale = hooks.filter(
      (h) =>
        !!h.config?.url &&
        h.config.url.startsWith(args.urlPrefix) &&
        !keep.has(h.config.url),
    );
    let deleted = 0;
    for (const h of stale) {
      const res = await this.fetchImpl(
        `${API}/repos/${args.owner}/${args.repo}/hooks/${h.id}`,
        { method: 'DELETE', headers: this.headers(token) },
      );
      if (res.ok) deleted++;
    }
    return deleted;
  }

  /**
   * Batched mergeability for every OPEN PR targeting `base` in ONE GraphQL query (paginated) — the
   * base-move refresh that replaces a per-PR REST fan-out. Draws on the SEPARATE GraphQL budget
   * ({@link isGraphqlRateLimited}); throws {@link RateLimitedError} while that budget is paused.
   */
  async listOpenPullMergeability(
    token: string,
    { owner, repo, base }: { owner: string; repo: string; base: string },
  ): Promise<
    Array<{
      number: number;
      mergeStateStatus: string;
      mergeableState: string;
      headSha: string | null;
    }>
  > {
    if (this.isGraphqlRateLimited()) {
      throw new RateLimitedError(
        `GitHub GraphQL rate-limited until ${new Date(this.graphqlPausedUntil!).toISOString()}`,
      );
    }
    const query =
      'query($owner:String!,$name:String!,$base:String!,$cursor:String){' +
      'repository(owner:$owner,name:$name){' +
      'pullRequests(first:100,states:OPEN,baseRefName:$base,after:$cursor){' +
      'nodes{ number mergeable mergeStateStatus headRefOid }' +
      'pageInfo{ endCursor hasNextPage }' +
      '} } }';
    const MAX_PAGES = 10;
    const out: Array<{
      number: number;
      mergeStateStatus: string;
      mergeableState: string;
      headSha: string | null;
    }> = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.fetchImpl(`${API}/graphql`, {
        method: 'POST',
        headers: this.headers(token),
        body: JSON.stringify({
          query,
          variables: { owner, name: repo, base, cursor },
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        data?: {
          repository?: {
            pullRequests?: {
              nodes?: Array<{
                number: number;
                mergeStateStatus?: string | null;
                headRefOid?: string | null;
              }>;
              pageInfo?: { endCursor?: string | null; hasNextPage?: boolean };
            };
          };
        };
        errors?: Array<{ message?: string }>;
      };
      this.captureGraphqlRateLimit(res, json);
      const errorMessage = (json.errors ?? [])
        .map((e) => e.message)
        .filter(Boolean)
        .join('; ');
      const rateLimitError = /rate limit|RATE_LIMITED|abuse detection/i.test(
        errorMessage,
      );
      if (
        this.isGraphqlRateLimited() &&
        (res.status === 403 || res.status === 429 || rateLimitError)
      ) {
        throw new RateLimitedError(
          `GitHub GraphQL rate-limited until ${new Date(this.graphqlPausedUntil!).toISOString()}`,
        );
      }
      if (!res.ok || json.errors?.length) {
        throw new Error(
          `GitHub refused the mergeability query for ${owner}/${repo} (${res.status}): ${
            json.errors
              ?.map((e) => e.message)
              .filter(Boolean)
              .join('; ') || 'no detail'
          }`,
        );
      }
      const connection = json.data?.repository?.pullRequests;
      for (const node of connection?.nodes ?? []) {
        out.push({
          number: node.number,
          mergeStateStatus: node.mergeStateStatus ?? 'UNKNOWN',
          mergeableState: mapMergeStateStatus(node.mergeStateStatus),
          headSha: node.headRefOid ?? null,
        });
      }
      if (
        !connection?.pageInfo?.hasNextPage ||
        !connection.pageInfo.endCursor
      ) {
        break;
      }
      if (this.isGraphqlRateLimited()) {
        throw new RateLimitedError(
          `GitHub GraphQL rate-limited until ${new Date(this.graphqlPausedUntil!).toISOString()}`,
        );
      }
      cursor = connection.pageInfo.endCursor;
    }
    return out;
  }
}
