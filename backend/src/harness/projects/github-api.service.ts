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
}

export interface PullRequestResult {
  url: string;
  number: number;
  /** True when an open PR for this head already existed and was returned instead. */
  existing: boolean;
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
  async openPullRequest(token: string, args: OpenPullRequestArgs): Promise<PullRequestResult> {
    const { owner, repo, head, base, title, body } = args;
    const res = await this.fetchImpl(`${API}/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({ title, head, base, ...(body ? { body } : {}) }),
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
        `${API}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&state=open`,
        { headers: this.headers(token) },
      );
      if (list.ok) {
        const prs = (await list.json()) as Array<{ html_url: string; number: number }>;
        if (prs[0]) return { url: prs[0].html_url, number: prs[0].number, existing: true };
      }
    }
    throw new Error(`GitHub refused the pull request (${res.status}): ${detail || 'no detail'}`);
  }
}
