import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Db } from '@workspace/nestjs-rls/nest';
import { createHmac, timingSafeEqual } from 'crypto';
import { Repo } from '../../_lib/database/entities/repo.entity';
import { OrgCredentialsService } from '../org-credentials/credentials.service';
import { GithubApiService } from './github-api.service';
import { GithubTokenService } from './github-token.service';

@Injectable()
export class GithubWebhookService implements OnApplicationBootstrap {
  private readonly logger = new Logger(this.constructor.name);
  private readonly isTestDb: boolean;

  constructor(
    private readonly env: EnvService,
    private readonly tokens: GithubTokenService,
    private readonly credentials: OrgCredentialsService,
    private readonly api: GithubApiService,
    private readonly db: Db,
  ) {
    this.isTestDb = /_test$/.test(env.get('POSTGRES_DB'));
  }

  /** One-shot backfill so already-connected repos get (or refresh) their hooks after a deploy. */
  async onApplicationBootstrap(): Promise<void> {
    if (this.isTestDb) return;
    if (!this.publicBase()) return; // no public host (dev) → nothing to register
    const repos = await this.db.unsafe(Repo).find({ where: { accessOk: true } });
    for (const repo of repos) {
      const parsed = this.parseOwnerRepo(repo.gitUrl);
      if (!parsed) continue;
      try {
        const warning = await this.ensureForRepo(repo.orgId, parsed.owner, parsed.repo);
        if (repo.webhookWarning !== warning) {
          repo.webhookWarning = warning;
          await this.db.unsafe(Repo).save(repo);
        }
      } catch (err) {
        this.logger.warn(`webhook backfill failed for ${repo.slug}: ${this.reason(err)}`);
      }
    }
  }

  async ensureForRepo(orgId: string, owner: string, repo: string): Promise<string | null> {
    // App installation → the App-level webhook covers every repo the installation can see. No per-repo hook.
    if (await this.credentials.getGithubAppInstallation(orgId)) return null;

    const base = this.publicBase();
    if (!base) return null;
    const token = await this.tokens.hostToken(orgId); // PAT here — the org has no App installation
    if (!token) return null;

    const url = `${base}/${WEBHOOK_PATH}`;
    const result = await this.api.ensureWebhook(token, {
      owner,
      repo,
      url,
      secret: this.env.get('GITHUB_WEBHOOK_SECRET'),
      events: WEBHOOK_EVENTS,
    });
    await this.api
      .pruneWebhooksExcept(token, {
        owner,
        repo,
        urlPrefix: `${base}/${WEBHOOK_PATH}`,
        keepUrls: [url],
      })
      .catch(() => 0);

    if (result === 'no-scope')
      return 'GitHub PAT lacks webhook (admin:repo_hook) scope — PR/CI updates fall back to polling.';
    if (result === 'error') return 'Failed to register GitHub webhooks.';
    return null;
  }

  /** Resolve an inbound `repository.full_name` to its owning org + repo, or null when not connected. */
  async route(fullName: string): Promise<{ orgId: string; repoId: string } | null> {
    const gitUrl = `https://github.com/${fullName}`;
    const repo = await this.db.unsafe(Repo).findOne({ where: { gitUrl } });
    return repo ? { orgId: repo.orgId, repoId: repo.id } : null;
  }

  handleVerifiedEvent(args: {
    orgId: string;
    repoId: string;
    eventType: string;
    payload: unknown;
  }): void {
    this.logger.debug(
      `github webhook ${args.eventType} for repo ${args.repoId} (org ${args.orgId}) — no consumer wired yet`,
    );
  }

  verifyGithubSignature(
    rawBody: Buffer,
    signatureHeader: string | undefined,
    secret: string,
  ): boolean {
    if (!signatureHeader) return false;
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** The public https origin GitHub can reach, or null for loopback/private/non-https hosts (dev). */
  private publicBase(): string | null {
    const raw = this.env.get('BACKEND_HOST');

    if (!raw) return null;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    const isLoopback =
      host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
    const isPrivate =
      /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (isLoopback || isPrivate) return null;
    return u.origin;
  }

  private parseOwnerRepo(gitUrl: string): { owner: string; repo: string } | null {
    const m = gitUrl.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
    return m ? { owner: m[1], repo: m[2] } : null;
  }

  private reason(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

const WEBHOOK_PATH = 'webhooks/github';
const WEBHOOK_EVENTS = [
  'workflow_run',
  'check_run',
  'check_suite',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
  'pull_request',
  'push',
];
