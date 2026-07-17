import { Injectable } from '@nestjs/common';
import type { AutoMergeMethod } from '@workspace/shared';


const API = 'https://api.github.com';

function isOkStatus(status: number): boolean {
  return status === 304 || (status >= 200 && status < 300);
}

function encodeRefPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

export const WORK_EVENTS = [
  'workflow_run',
  'check_run',
  'check_suite',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
];
export const STATE_EVENTS = ['pull_request', 'push'];

export interface OpenPullRequestArgs {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export interface PullRequestResult {
  url: string;
  number: number;
  existing: boolean;
}

export interface PullDetail {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed' | 'gone';
  mergeableState: string | null;
  headSha: string | null;
  headRef: string | null;
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
}

export type CiCounts = {
  failing: number;
  pending: number;
  passed: number;
  skipped: number;
  total: number;
};
export type CiSummary = {
  status: 'failure' | 'pending' | 'success' | 'skipped' | null;
  counts: CiCounts | null;
};

export interface PullReview {
  id: number;
  author: string | null;
  state: string;
  body: string | null;
  submittedAt: string | null;
  url: string | null;
}

export type MergeResult =
  | { ok: true; sha: string }
  | {
      ok: false;
      reason: 'not_mergeable' | 'sha_mismatch' | 'already_merged' | 'method_disallowed' | 'other';
      status: number;
      message: string;
    };

export interface RepoInfo {
  fullName: string;
  owner: string;
  name: string;
  htmlUrl: string;
  defaultBranch: string;
  private: boolean;
  description: string | null;
}

export function parseGithubRepoUrl(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export class RateLimitedError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

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

  private readonly etagCache = new Map<string, { etag: string; body: unknown }>();
  private static readonly MAX_ETAG_ENTRIES = 2000;

  private pausedUntil: number | null = null;
  private consecutivePauses = 0;

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

  isRateLimited(): boolean {
    return this.pausedUntil != null && this.pausedUntil > Date.now();
  }

  isGraphqlRateLimited(): boolean {
    return this.graphqlPausedUntil != null && this.graphqlPausedUntil > Date.now();
  }

  private touchLru(url: string): void {
    const hit = this.etagCache.get(url);
    if (!hit) return;
    this.etagCache.delete(url);
    this.etagCache.set(url, hit);
  }

  private storeLru(url: string, etag: string, body: unknown): void {
    this.etagCache.delete(url);
    this.etagCache.set(url, { etag, body });
    if (this.etagCache.size > GithubPrService.MAX_ETAG_ENTRIES) {
      const oldest = this.etagCache.keys().next().value;
      if (oldest !== undefined) this.etagCache.delete(oldest);
    }
  }

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

  private isRateLimitResponse(
    remaining: number | null,
    retryAfterMs: number | null,
    body?: { message?: string },
  ): boolean {
    return (
      remaining === 0 ||
      retryAfterMs != null ||
      /secondary rate limit|rate limit|abuse detection/i.test(body?.message ?? '')
    );
  }

  private backoffMs(consecutivePauses: number): number {
    return 60_000 * 2 ** Math.min(consecutivePauses, 4);
  }

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
    const errorRateLimited = /rate limit|RATE_LIMITED|abuse detection/i.test(errorMessage);

    if (remaining === 0) {
      this.graphqlPausedUntil = Math.max(
        resetMs ?? 0,
        retryAfterMs != null ? now + retryAfterMs : 0,
        now + this.backoffMs(this.graphqlConsecutivePauses++),
      );
      return;
    }
    if (status >= 200 && status < 300 && remaining != null && !errorRateLimited) {
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

  async openPullRequest(token: string, args: OpenPullRequestArgs): Promise<PullRequestResult> {
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
    const detail = [errBody.message, ...(errBody.errors ?? []).map((e) => e.message)]
      .filter(Boolean)
      .join('; ');
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
    throw new Error(`GitHub refused the pull request (${res.status}): ${detail || 'no detail'}`);
  }

  async markReadyForReview(
    token: string,
    { owner, repo, number }: { owner: string; repo: string; number: number },
  ): Promise<{ isDraft: boolean }> {
    const get = await this.fetchImpl(`${API}/repos/${owner}/${repo}/pulls/${number}`, {
      headers: this.headers(token),
    });
    if (!get.ok) throw new Error(`GitHub couldn't load PR #${number} (${get.status})`);
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
      isDraft: json.data?.markPullRequestReadyForReview?.pullRequest?.isDraft ?? false,
    };
  }

  async closePullRequest(
    token: string,
    { owner, repo, number }: { owner: string; repo: string; number: number },
  ): Promise<void> {
    const res = await this.fetchImpl(`${API}/repos/${owner}/${repo}/pulls/${number}`, {
      method: 'PATCH',
      headers: this.headers(token),
      body: JSON.stringify({ state: 'closed' }),
    });
    if (res.ok) return;
    const errBody = (await res.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(
      `GitHub refused to close PR #${number} (${res.status}): ${errBody.message ?? 'no detail'}`,
    );
  }

  async mergePullRequest(
    token: string,
    {
      owner,
      repo,
      number,
      method,
      sha,
    }: {
      owner: string;
      repo: string;
      number: number;
      method: AutoMergeMethod;
      sha?: string;
    },
  ): Promise<MergeResult> {
    const res = await this.fetchImpl(`${API}/repos/${owner}/${repo}/pulls/${number}/merge`, {
      method: 'PUT',
      headers: this.headers(token),
      body: JSON.stringify({
        merge_method: method,
        ...(sha ? { sha } : {}),
      }),
    });
    if (res.ok) {
      const b = (await res.json().catch(() => ({}))) as { sha?: string };
      return { ok: true, sha: b.sha ?? '' };
    }
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    const message = body.message ?? 'no detail';
    let reason: Exclude<MergeResult, { ok: true }>['reason'] = 'other';
    if (res.status === 409) reason = 'sha_mismatch';
    else if (res.status === 422) reason = 'method_disallowed';
    else if (res.status === 405) {
      reason = /already merged/i.test(message) ? 'already_merged' : 'not_mergeable';
    }
    return { ok: false, reason, status: res.status, message };
  }

  async deleteBranch(
    token: string,
    { owner, repo, branch }: { owner: string; repo: string; branch: string },
  ): Promise<void> {
    const res = await this.fetchImpl(
      `${API}/repos/${owner}/${repo}/git/refs/heads/${encodeRefPath(branch)}`,
      { method: 'DELETE', headers: this.headers(token) },
    );
    if (res.ok || res.status === 404 || res.status === 422) return;
    const errBody = (await res.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(
      `GitHub refused to delete branch ${branch} (${res.status}): ${errBody.message ?? 'no detail'}`,
    );
  }

  async commentOnPullRequest(
    token: string,
    { owner, repo, number, body }: { owner: string; repo: string; number: number; body: string },
  ): Promise<void> {
    const res = await this.fetchImpl(`${API}/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(
        `GitHub refused the PR comment (${res.status}): ${errBody.message ?? 'no detail'}`,
      );
    }
  }

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

  async findOpenPullByHead(
    token: string,
    { owner, repo, head }: { owner: string; repo: string; head: string },
  ): Promise<{ url: string; number: number } | null> {
    const { status, body } = await this.conditionalGet<Array<{ html_url: string; number: number }>>(
      `${API}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open`,
      token,
    );
    if (!isOkStatus(status)) return null;
    const prs = body;
    return prs[0] ? { url: prs[0].html_url, number: prs[0].number } : null;
  }

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

  async listBranches(token: string, owner: string, repo: string): Promise<string[]> {
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

  async getRepo(token: string, owner: string, repo: string): Promise<RepoInfo | null> {
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
    const list = await this.fetchImpl(`${API}/repos/${args.owner}/${args.repo}/hooks`, {
      headers: this.headers(token),
    });
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
    const created = await this.fetchImpl(`${API}/repos/${args.owner}/${args.repo}/hooks`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify(body),
    });
    if (created.status === 403 || created.status === 404) return 'no-scope';
    return created.ok ? 'created' : 'error';
  }

  async pruneWebhooksExcept(
    token: string,
    args: {
      owner: string;
      repo: string;
      urlPrefix: string;
      keepUrls: string[];
    },
  ): Promise<number> {
    const list = await this.fetchImpl(`${API}/repos/${args.owner}/${args.repo}/hooks`, {
      headers: this.headers(token),
    });
    if (!list.ok) return 0;
    const hooks = (await list.json()) as Array<{
      id: number;
      config?: { url?: string };
    }>;
    const keep = new Set(args.keepUrls);
    const stale = hooks.filter(
      (h) => !!h.config?.url && h.config.url.startsWith(args.urlPrefix) && !keep.has(h.config.url),
    );
    let deleted = 0;
    for (const h of stale) {
      const res = await this.fetchImpl(`${API}/repos/${args.owner}/${args.repo}/hooks/${h.id}`, {
        method: 'DELETE',
        headers: this.headers(token),
      });
      if (res.ok) deleted++;
    }
    return deleted;
  }

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
      const rateLimitError = /rate limit|RATE_LIMITED|abuse detection/i.test(errorMessage);
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
      if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) {
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
