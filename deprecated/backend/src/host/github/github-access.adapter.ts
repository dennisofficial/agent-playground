import { Injectable } from '@nestjs/common';
import { GithubApiError, GithubApiService } from './github-api.service';
import { GithubTokenService } from './github-token.service';
import { GithubWebhookService } from './github-webhook.service';

export interface RepoProbe {
  accessOk: boolean;
  /** Human reason when `accessOk === false`. */
  reason?: string;
  /** Set when `accessOk === true`. */
  defaultBranch?: string;
}

@Injectable()
export class GithubAccessAdapter {
  constructor(
    private readonly tokens: GithubTokenService,
    private readonly api: GithubApiService,
    private readonly webhooks: GithubWebhookService,
  ) {}

  hasGithub(orgId: string): Promise<boolean> {
    return this.tokens.hasAnyGithub(orgId);
  }

  async probeRepo(orgId: string, owner: string, repo: string): Promise<RepoProbe> {
    const token = await this.tokens.hostToken(orgId);
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
    const token = await this.tokens.hostToken(orgId);
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

  /** Register Atlas's inbound webhooks for the repo; returns a soft warning to store, or null. */
  ensureWebhook(orgId: string, owner: string, repo: string): Promise<string | null> {
    return this.webhooks.ensureForRepo(orgId, owner, repo);
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
