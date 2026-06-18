import { Injectable } from '@nestjs/common';

export interface OpenPullRequestArgs {
  owner: string;
  repo: string;
  /** The PR's source branch (the shared integration branch). */
  head: string;
  /** The PR's target branch (the project's default branch). */
  base: string;
  title: string;
  body?: string;
  /** Open as a DRAFT PR (the default for in-progress work — `mark_pr_ready` un-drafts it). */
  draft?: boolean;
}

export interface PullRequestResult {
  url: string;
  number: number;
  /** True when an open PR for this head already existed and was returned instead. */
  existing: boolean;
}

/** A repo as resolved during onboarding (the subset onboard_project needs to register it). */
export interface RepoInfo {
  /** "<owner>/<repo>". */
  fullName: string;
  owner: string;
  name: string;
  /** The HTTPS clone/registry URL (no `.git` suffix). */
  htmlUrl: string;
  defaultBranch: string;
  private: boolean;
  /** GitHub's repo description, if any — seeds the project catalog blurb. */
  description: string | null;
}

/** Parse an `https://github.com/<owner>/<repo>` URL into its parts (drops any `.git`). null if it isn't one. */
export function parseGithubRepoUrl(
  url: string,
): { owner: string; repo: string } | null {
  const m = url
    .trim()
    .match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** A single open PR returned by `listOpenPullRequests`. */
export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  author: string;
  headBranch: string;
  baseBranch: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
}

const API = 'https://api.github.com';

/**
 * Minimal GitHub REST client — one concern (pull requests), zero dependencies (global fetch).
 * `fetchImpl` is an overridable seam for specs. Errors carry GitHub's status + message, never the
 * token.
 */
@Injectable()
export class GithubApiService {
  fetchImpl: typeof fetch = fetch;

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agent-playground', // GitHub rejects UA-less requests
      'Content-Type': 'application/json',
    };
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
        `${API}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&state=open`,
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
   * Flip a DRAFT PR to ready-for-review — the "it's your turn, Dennis" signal. GitHub exposes this
   * ONLY via the GraphQL `markPullRequestReadyForReview` mutation, which needs the PR's node id, so
   * we fetch that over REST first. Idempotent enough: marking an already-ready PR is a no-op error
   * GitHub tolerates. Returns the resulting draft flag (false on success).
   */
  async markReadyForReview(
    token: string,
    { owner, repo, number }: { owner: string; repo: string; number: number },
  ): Promise<{ isDraft: boolean }> {
    const get = await this.fetchImpl(
      `${API}/repos/${owner}/${repo}/pulls/${number}`,
      { headers: this.headers(token) },
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
    if (!res.ok || json.errors?.length)
      throw new Error(
        `GitHub refused mark-ready for PR #${number} (${res.status}): ${
          json.errors
            ?.map((e) => e.message)
            .filter(Boolean)
            .join('; ') || 'no detail'
        }`,
      );
    return {
      isDraft:
        json.data?.markPullRequestReadyForReview?.pullRequest?.isDraft ?? false,
    };
  }

  /**
   * Update a PR's title/body — used to aggregate a shared feature's sibling tickets onto the PR at
   * ship time (the draft was opened with just the first ticket's metadata). Best-effort by the caller.
   */
  async updatePullRequest(
    token: string,
    {
      owner,
      repo,
      number,
      title,
      body,
    }: {
      owner: string;
      repo: string;
      number: number;
      title?: string;
      body?: string;
    },
  ): Promise<void> {
    const res = await this.fetchImpl(
      `${API}/repos/${owner}/${repo}/pulls/${number}`,
      {
        method: 'PATCH',
        headers: this.headers(token),
        body: JSON.stringify({
          ...(title !== undefined ? { title } : {}),
          ...(body !== undefined ? { body } : {}),
        }),
      },
    );
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(
        `GitHub refused the PR update (${res.status}): ${errBody.message ?? 'no detail'}`,
      );
    }
  }

  /**
   * Post a comment on a PR (the integration self-review's findings, in advisory mode). PRs are issues
   * for the comments API, so this hits the issues endpoint. Best-effort by the caller — a failed
   * comment must never block shipping the PR.
   */
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

  private toRepoInfo(r: {
    full_name: string;
    owner: { login: string };
    name: string;
    html_url: string;
    default_branch: string;
    private: boolean;
    description: string | null;
  }): RepoInfo {
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

  /** Fetch one repo the token can see — the onboarding probe. null on 404/403 (not found OR no access,
   * which onboarding treats the same: "I can't reach it, collect a token"); throws on other failures. */
  async getRepo(
    token: string,
    owner: string,
    repo: string,
  ): Promise<RepoInfo | null> {
    const res = await this.fetchImpl(`${API}/repos/${owner}/${repo}`, {
      headers: this.headers(token),
    });
    if (res.ok)
      return this.toRepoInfo(
        (await res.json()) as Parameters<typeof this.toRepoInfo>[0],
      );
    if (res.status === 404 || res.status === 403) return null;
    const errBody = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(
      `GitHub couldn't load ${owner}/${repo} (${res.status}): ${errBody.message ?? 'no detail'}`,
    );
  }

  /**
   * Repos accessible to the token whose NAME matches `name` (case-insensitive) — the by-name onboarding
   * resolver. Reads the token's own repo list (owner + collaborator + org member), one page of 100
   * (enough at Dennis's scale; larger orgs would need pagination — caller notes the cap). Read-only.
   */
  async searchAccessibleRepos(
    token: string,
    name: string,
  ): Promise<RepoInfo[]> {
    const want = name.trim().toLowerCase();
    const res = await this.fetchImpl(
      `${API}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`,
      { headers: this.headers(token) },
    );
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(
        `GitHub couldn't list your repos (${res.status}): ${errBody.message ?? 'no detail'}`,
      );
    }
    const repos = (await res.json()) as Array<
      Parameters<typeof this.toRepoInfo>[0]
    >;
    return repos
      .map((r) => this.toRepoInfo(r))
      .filter((r) => r.name.toLowerCase() === want);
  }

  /** List the open PRs on a repo (up to 50, newest first). */
  async listOpenPullRequests(
    token: string,
    { owner, repo }: { owner: string; repo: string },
  ): Promise<PullRequestSummary[]> {
    const res = await this.fetchImpl(
      `${API}/repos/${owner}/${repo}/pulls?state=open&per_page=50&sort=created&direction=desc`,
      { headers: this.headers(token) },
    );
    if (res.ok) {
      const prs = (await res.json()) as Array<{
        number: number;
        title: string;
        html_url: string;
        user: { login: string };
        head: { ref: string };
        base: { ref: string };
        draft: boolean;
        created_at: string;
        updated_at: string;
      }>;
      return prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        author: pr.user.login,
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        draft: pr.draft,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
      }));
    }
    const errBody = (await res.json().catch(() => ({}))) as {
      message?: string;
    };
    const detail = errBody.message ?? 'no detail';
    throw new Error(
      `GitHub refused the pull request list (${res.status}): ${detail}`,
    );
  }
}
