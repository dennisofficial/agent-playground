import { OCTOKIT_SDK, type OctokitSdk } from '@lib/esm/octokit.provider';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { throttleOptions } from './github-octokit';

export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GithubApiError';
  }
}

@Injectable()
export class GithubApiService {
  private readonly logger = new Logger(this.constructor.name);
  /** Test seam: swap the underlying fetch used by every Octokit built here. */
  fetchImpl: typeof fetch = fetch;

  constructor(@Inject(OCTOKIT_SDK) private readonly sdk: OctokitSdk) {}

  /** `GET /repos/{owner}/{repo}` — repo metadata; throws {@link GithubApiError} 404 when missing/invisible. */
  async getRepo(token: string, owner: string, repo: string): Promise<RepoInfo> {
    return this.run(async () => {
      const { data } = await this.client(token).rest.repos.get({ owner, repo });
      return {
        fullName: data.full_name,
        defaultBranch: data.default_branch,
        private: data.private,
      };
    });
  }

  /** `GET /repos/{owner}/{repo}/branches` — all branch names (Octokit auto-paginates). */
  async listBranches(token: string, owner: string, repo: string): Promise<string[]> {
    return this.run(async () => {
      const kit = this.client(token);
      const branches = await kit.paginate(kit.rest.repos.listBranches, {
        owner,
        repo,
        per_page: 100,
      });
      return branches.map((b) => b.name);
    });
  }

  /** `GET /user` — the token's own identity; used to resolve a PAT's commit author (the "face"). */
  async getAuthenticatedUser(
    token: string,
  ): Promise<{ login: string; id: number; name: string | null }> {
    return this.run(async () => {
      const { data } = await this.client(token).rest.users.getAuthenticated();
      return { login: data.login, id: data.id, name: data.name ?? null };
    });
  }

  async ensureWebhook(
    token: string,
    args: { owner: string; repo: string; url: string; secret: string; events: string[] },
  ): Promise<'created' | 'updated' | 'no-scope' | 'error'> {
    const kit = this.client(token);
    const config = { url: args.url, content_type: 'json', secret: args.secret, insecure_ssl: '0' };
    try {
      const hooks = await kit.paginate(kit.rest.repos.listWebhooks, {
        owner: args.owner,
        repo: args.repo,
        per_page: 100,
      });
      const mine = hooks.find((h) => h.config?.url === args.url);
      if (mine) {
        await kit.rest.repos.updateWebhook({
          owner: args.owner,
          repo: args.repo,
          hook_id: mine.id,
          config,
          events: args.events,
          active: true,
        });
        return 'updated';
      }
      await kit.rest.repos.createWebhook({
        owner: args.owner,
        repo: args.repo,
        config,
        events: args.events,
        active: true,
      });
      return 'created';
    } catch (err) {
      if (err instanceof this.sdk.RequestError && (err.status === 403 || err.status === 404))
        return 'no-scope';
      this.logger.warn(`ensureWebhook failed for ${args.owner}/${args.repo}: ${String(err)}`);
      return 'error';
    }
  }

  /** Delete Atlas hooks under `urlPrefix` that aren't in `keepUrls` (repointed host / stale routes). */
  async pruneWebhooksExcept(
    token: string,
    args: { owner: string; repo: string; urlPrefix: string; keepUrls: string[] },
  ): Promise<number> {
    const kit = this.client(token);
    try {
      const hooks = await kit.paginate(kit.rest.repos.listWebhooks, {
        owner: args.owner,
        repo: args.repo,
        per_page: 100,
      });
      const keep = new Set(args.keepUrls);
      const stale = hooks.filter(
        (h) =>
          !!h.config?.url && h.config.url.startsWith(args.urlPrefix) && !keep.has(h.config.url),
      );
      for (const h of stale) {
        await kit.rest.repos.deleteWebhook({ owner: args.owner, repo: args.repo, hook_id: h.id });
      }
      return stale.length;
    } catch {
      return 0;
    }
  }

  private client(token: string) {
    return new this.sdk.AtlasOctokit({
      auth: token,
      userAgent: 'atlas',
      throttle: throttleOptions(this.logger),
      request: { fetch: this.fetchImpl },
    });
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof this.sdk.RequestError) throw new GithubApiError(err.status, err.message);
      throw err;
    }
  }
}
