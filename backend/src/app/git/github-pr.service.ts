import { Injectable } from '@nestjs/common';

/**
 * Atlas v2's minimal GitHub REST client — a clean-room rewrite of v1's `GithubApiService`, scoped to
 * the PR/repo concerns W1 needs (open/find a PR, mark ready, probe a repo). Zero dependencies (global
 * `fetch`); `fetchImpl` is the spec seam. The token rides in the Authorization header per request —
 * errors carry GitHub's status + message but NEVER the token.
 */

const API = 'https://api.github.com';

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
export function parseGithubRepoUrl(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

@Injectable()
export class GithubPrService {
  fetchImpl: typeof fetch = fetch;

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'atlas', // GitHub rejects UA-less requests
      'Content-Type': 'application/json',
    };
  }

  /** Create the PR, or return the already-open one for the same head (idempotent). */
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
    // 422 "A pull request already exists for <owner>:<head>" → find and return it.
    if (res.status === 422 && /already exists/i.test(detail)) {
      const list = await this.fetchImpl(
        `${API}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(
          `${owner}:${head}`,
        )}&base=${encodeURIComponent(base)}&state=open`,
        { headers: this.headers(token) },
      );
      if (list.ok) {
        const prs = (await list.json()) as Array<{ html_url: string; number: number }>;
        if (prs[0]) return { url: prs[0].html_url, number: prs[0].number, existing: true };
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
      data?: { markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } } };
      errors?: Array<{ message?: string }>;
    };
    if (!res.ok || json.errors?.length) {
      throw new Error(
        `GitHub refused mark-ready for PR #${number} (${res.status}): ${
          json.errors?.map((e) => e.message).filter(Boolean).join('; ') || 'no detail'
        }`,
      );
    }
    return {
      isDraft: json.data?.markPullRequestReadyForReview?.pullRequest?.isDraft ?? false,
    };
  }

  /** Post a comment on a PR (PRs are issues for the comments API). Best-effort by the caller. */
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
      const errBody = (await res.json().catch(() => ({}))) as { message?: string };
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
    const res = await this.fetchImpl(`${API}/repos/${owner}/${repo}/pulls/${number}`, {
      headers: this.headers(token),
    });
    if (res.status === 404) return 'gone';
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(`GitHub couldn't load PR #${number} (${res.status}): ${errBody.message ?? 'no detail'}`);
    }
    const pr = (await res.json()) as { state: 'open' | 'closed'; merged?: boolean; merged_at?: string | null };
    if (pr.merged || pr.merged_at) return 'merged';
    return pr.state;
  }

  /**
   * List a repo's branch names with the token — feeds the create-thread base-branch picker. Paginated
   * (100/page) and capped so a repo with thousands of branches can't run the request away. Returns the
   * names in GitHub's order (the caller surfaces the default branch first); throws on a non-OK response.
   */
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
        const errBody = (await res.json().catch(() => ({}))) as { message?: string };
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
    const errBody = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(
      `GitHub couldn't load ${owner}/${repo} (${res.status}): ${errBody.message ?? 'no detail'}`,
    );
  }
}
