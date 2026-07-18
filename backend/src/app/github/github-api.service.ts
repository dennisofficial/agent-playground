import { Injectable } from '@nestjs/common';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'atlas';
const BRANCHES_PER_PAGE = 100;
const MAX_BRANCH_PAGES = 20; // safety cap: 2000 branches is far beyond any real repo

/** Minimal repo metadata Atlas needs. */
export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

/** A non-2xx response from the GitHub REST API, carrying the HTTP status for the caller to branch on. */
export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GithubApiError';
  }
}

/**
 * Thin, token-agnostic client for the GitHub REST API. Every call takes the bearer token explicitly —
 * it holds no credential state and knows nothing about orgs or PAT-vs-App resolution (that's
 * {@link GithubCredentialsService}). Non-2xx responses throw {@link GithubApiError} with the status.
 */
@Injectable()
export class GithubApiService {
  /** `GET /repos/{owner}/{repo}` — repo metadata; throws 404 when missing or the token can't see it. */
  async getRepo(token: string, owner: string, repo: string): Promise<RepoInfo> {
    const data = await this.request<{
      full_name: string;
      default_branch: string;
      private: boolean;
    }>(token, `/repos/${owner}/${repo}`);
    return { fullName: data.full_name, defaultBranch: data.default_branch, private: data.private };
  }

  /** `GET /repos/{owner}/{repo}/branches` — all branch names, paginated. */
  async listBranches(token: string, owner: string, repo: string): Promise<string[]> {
    const names: string[] = [];
    for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
      const batch = await this.request<{ name: string }[]>(
        token,
        `/repos/${owner}/${repo}/branches?per_page=${BRANCHES_PER_PAGE}&page=${page}`,
      );
      names.push(...batch.map((b) => b.name));
      if (batch.length < BRANCHES_PER_PAGE) break;
    }
    return names;
  }

  /** `GET /user` — the token's own identity; used to resolve a PAT's commit author. */
  async getAuthenticatedUser(token: string): Promise<{ login: string }> {
    const data = await this.request<{ login: string }>(token, '/user');
    return { login: data.login };
  }

  private async request<T>(token: string, path: string): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': API_VERSION,
        'user-agent': USER_AGENT,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new GithubApiError(
        res.status,
        `GitHub ${res.status} on ${path}: ${body.slice(0, 200)}`,
      );
    }
    return (await res.json()) as T;
  }
}
