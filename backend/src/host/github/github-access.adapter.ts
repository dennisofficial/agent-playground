import { Injectable } from '@nestjs/common';
import { GithubApiError, GithubApiService } from './github-api.service';
import { GithubCredentialsService } from './github-credentials.service';

export interface RepoProbe {
  accessOk: boolean;
  /** Human reason when `accessOk === false`. */
  reason?: string;
  /** Set when `accessOk === true`. */
  defaultBranch?: string;
}

/**
 * Everything the repos slice needs from GitHub. It bridges the token-agnostic {@link GithubApiService} and
 * the org's resolved credential ({@link GithubCredentialsService}), and translates GitHub errors into
 * graceful shapes (never throws for expected failures like a missing token or an unreachable repo — the
 * repos slice records those as `accessOk:false`). Injected directly by the repos slice — no port; one impl,
 * and github doesn't import repo, so there's no cycle.
 */
@Injectable()
export class GithubAccessAdapter {
  constructor(
    private readonly credentials: GithubCredentialsService,
    private readonly api: GithubApiService,
  ) {}

  hasGithub(orgId: string): Promise<boolean> {
    return this.credentials.hasToken(orgId);
  }

  async probeRepo(orgId: string, owner: string, repo: string): Promise<RepoProbe> {
    const token = await this.credentials.resolveToken(orgId);
    if (!token) return { accessOk: false, reason: 'No GitHub token is configured for this org.' };
    try {
      const info = await this.api.getRepo(token, owner, repo);
      return { accessOk: true, defaultBranch: info.defaultBranch };
    } catch (err) {
      return { accessOk: false, reason: this.reasonFor(err, owner, repo) };
    }
  }

  async listBranches(
    orgId: string,
    owner: string,
    repo: string,
  ): Promise<{ branches: string[]; defaultBranch: string } | null> {
    const token = await this.credentials.resolveToken(orgId);
    if (!token) return null;
    try {
      const [info, branches] = await Promise.all([
        this.api.getRepo(token, owner, repo),
        this.api.listBranches(token, owner, repo),
      ]);
      const { defaultBranch } = info;
      // Default branch first, then the rest in GitHub's order.
      const ordered = [defaultBranch, ...branches.filter((b) => b !== defaultBranch)];
      return { branches: ordered, defaultBranch };
    } catch {
      return null; // caller falls back to the stored default branch
    }
  }

  async ensureWebhook(_orgId: string, _owner: string, _repo: string): Promise<string | null> {
    // Webhook registration needs a public backend host + GITHUB_WEBHOOK_SECRET and an inbound webhook
    // route to receive events — none of which exist yet. Real-time PR/CI sync lands with the webhook
    // phase; until then there's nothing to register and no warning to surface.
    return Promise.resolve(null);
  }

  private reasonFor(err: unknown, owner: string, repo: string): string {
    if (err instanceof GithubApiError) {
      switch (err.status) {
        case 401:
          return 'GitHub token is invalid or expired.';
        case 403:
          return 'GitHub denied access (token scope or rate limit).';
        case 404:
          return `Repository ${owner}/${repo} not found, or the token cannot access it.`;
        default:
          return `GitHub error (${err.status}).`;
      }
    }
    return 'Could not reach GitHub.';
  }
}
