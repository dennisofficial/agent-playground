import { EnvService } from '@core/config/env/env.service';
import { ChatAnthropic } from '@langchain/anthropic';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import type { AutoMergeMethod } from '@workspace/shared';
import { IsNull, Repository } from 'typeorm';
import { JOB_TEARDOWN, type JobTeardownPort } from '../driver/job-teardown.port';
import {
  GithubPrService,
  parseGithubRepoUrl,
  STATE_EVENTS,
  WORK_EVENTS,
} from '../git/github-pr.service';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  InboundMessageEntity,
  JobEntity,
  JobSandboxEntity,
  OrganizationEntity,
  OrgCredentialsEntity,
  RepoEntity,
} from '../persistence/entities';
import { CredentialResolver } from './credential-resolver.service';
import { TenantCredentialStore } from './tenant-credential.store';

export type OrgLifecycle = 'onboarding' | 'active' | 'suspended';

export type OnboardingStep = 'repo' | 'llm_key' | 'openai_key' | 'engine_auth' | 'github_pat';

export interface OnboardingStatus {
  orgId: string;
  lifecycle: OrgLifecycle;
  steps: {
    repoConnected: boolean;
    llmKey: boolean;
    openaiKey: boolean;
    engineAuth: boolean;
    githubPat: boolean;
  };
  missing: OnboardingStep[];
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export interface ConnectRepoArgs {
  orgId: string;
  repoUrl: string;
  baseBranch?: string;
  displayName?: string;
}

export interface ConnectedRepo {
  id: string;
  slug: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
  branchPrefix: string | null;
  defaultAutoMergeMethod: AutoMergeMethod;
  defaultAutoMergeDeleteBranch: boolean;
  accessOk: boolean;
  reason?: string;
}

export function slugifyRepo(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'repo'
  );
}

export function publicBackendBase(env: EnvService): string | null {
  const raw = env.get('BACKEND_HOST');
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null; // GitHub needs a public https endpoint
  const host = u.hostname.toLowerCase();
  const isLoopback =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  const isPrivate =
    /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (isLoopback || isPrivate) return null;
  return u.origin;
}

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    @InjectRepository(OrganizationEntity, DB_CONNECTION)
    private readonly orgs: Repository<OrganizationEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    @InjectRepository(OrgCredentialsEntity, DB_CONNECTION)
    private readonly orgCreds: Repository<OrgCredentialsEntity>,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(InboundMessageEntity, DB_CONNECTION)
    private readonly stimuli: Repository<InboundMessageEntity>,
    @InjectRepository(DecisionRecordEntity, DB_CONNECTION)
    private readonly decisionRecords: Repository<DecisionRecordEntity>,
    @InjectRepository(JobSandboxEntity, DB_CONNECTION)
    private readonly sandboxes: Repository<JobSandboxEntity>,
    private readonly creds: CredentialResolver,
    private readonly store: TenantCredentialStore,
    private readonly pr: GithubPrService,
    @Inject(JOB_TEARDOWN) private readonly jobTeardown: JobTeardownPort,
    private readonly moduleRef: ModuleRef,
    private readonly env: EnvService,
  ) {}

  async connectRepo(args: ConnectRepoArgs): Promise<ConnectedRepo> {
    const { orgId, repoUrl } = args;
    const parsed = parseGithubRepoUrl(repoUrl);
    if (!parsed) {
      return {
        id: '',
        slug: '',
        name: '',
        gitUrl: repoUrl,
        defaultBranch: args.baseBranch ?? 'main',
        branchPrefix: null,
        defaultAutoMergeMethod: 'squash',
        defaultAutoMergeDeleteBranch: true,
        accessOk: false,
        reason: `not an HTTPS GitHub URL: ${repoUrl}`,
      };
    }
    const slug = slugifyRepo(parsed.repo);
    const name = args.displayName ?? parsed.repo;
    const baseBranch = args.baseBranch ?? 'main';

    await this.repos.upsert(
      {
        org_id: orgId,
        slug,
        name,
        git_url: repoUrl,
        default_branch: baseBranch,
        token_name: null,
      },
      ['org_id', 'slug'],
    );
    const repo = await this.repos.findOneOrFail({
      where: { org_id: orgId, slug },
    });

    const validation = await this.validateRepo(orgId, slug);
    await this.repos.update(
      { id: repo.id },
      { access_ok: validation.ok, access_checked_at: new Date() },
    );
    this.logger.log(
      `connected repo ${slug} (${repo.id}) → org ${orgId} (access_ok=${validation.ok})`,
    );

    if (validation.ok) {
      void this.maybeStartRepoOnboarding(orgId, repo.id).catch((err) =>
        this.logger.warn(`repo onboarding spawn failed for ${repo.id}: ${err}`),
      );
      void this.ensureRepoWebhook(orgId, repo).catch((err) =>
        this.logger.warn(`webhook registration failed for ${repo.id}: ${err}`),
      );
    }

    return {
      id: repo.id,
      slug,
      name,
      gitUrl: repoUrl,
      defaultBranch: baseBranch,
      branchPrefix: repo.branch_prefix ?? null,
      defaultAutoMergeMethod: repo.default_auto_merge_method,
      defaultAutoMergeDeleteBranch: repo.default_auto_merge_delete_branch,
      accessOk: validation.ok,
      ...(validation.reason ? { reason: validation.reason } : {}),
    };
  }

  async maybeStartRepoOnboarding(orgId: string, repoId: string): Promise<void> {
    const repo = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    if (!repo || !repo.access_ok || repo.onboarding_job_id) return; // gone / not validated / already done
    const status = await this.status(orgId);
    if (
      !(
        status.steps.llmKey &&
        status.steps.openaiKey &&
        status.steps.engineAuth &&
        status.steps.githubPat
      )
    ) {
      return; // org can't run Atlas yet — tryActivate will re-trigger once the credentials land
    }

    const { BrainStoreService } = await import('../brain/brain-store.service.js');
    const { AgentSessionManager } = await import('../brain/agent-session-manager.service.js');
    const store = this.moduleRef.get(BrainStoreService, { strict: false });
    const sessions = this.moduleRef.get(AgentSessionManager, { strict: false });

    const jobId = await store.createFollowUpJob({
      orgId,
      repoId,
      title: `Onboarding ${repo.name}`,
      baseBranch: repo.default_branch ?? 'main',
      kind: 'onboarding',
    });

    const claim = await this.repos.update(
      { id: repoId, org_id: orgId, onboarding_job_id: IsNull() },
      { onboarding_job_id: jobId },
    );
    if (!claim.affected) {
      await this.jobs.delete({ id: jobId, org_id: orgId }).catch(() => undefined);
      return;
    }

    this.logger.log(`spawned repo-onboarding thread ${jobId} for ${orgId}/${repo.slug}`);
    await sessions.startOnboardingThread(jobId, orgId, repoId);
  }

  async reonboardRepo(orgId: string, repoId: string): Promise<{ jobId: string }> {
    const repo = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    if (!repo) throw new NotFoundException('repo not found');
    if (!repo.access_ok) {
      throw new BadRequestException(
        'This repo isn’t validated — re-validate GitHub access before running onboarding.',
      );
    }
    const status = await this.status(orgId);
    if (
      !(
        status.steps.llmKey &&
        status.steps.openaiKey &&
        status.steps.engineAuth &&
        status.steps.githubPat
      )
    ) {
      throw new BadRequestException(
        'Finish org setup (Anthropic key, OpenAI key, engine auth, GitHub access (PAT or App)) before onboarding a repo.',
      );
    }

    const { BrainStoreService } = await import('../brain/brain-store.service.js');
    const { AgentSessionManager } = await import('../brain/agent-session-manager.service.js');
    const store = this.moduleRef.get(BrainStoreService, { strict: false });
    const sessions = this.moduleRef.get(AgentSessionManager, { strict: false });

    const jobId = await store.createFollowUpJob({
      orgId,
      repoId,
      title: `Onboarding ${repo.name}`,
      baseBranch: repo.default_branch ?? 'main',
      kind: 'onboarding',
    });
    await this.repos.update({ id: repoId, org_id: orgId }, { onboarding_job_id: jobId });
    this.logger.log(`re-onboarding thread ${jobId} for ${orgId}/${repo.slug} (operator-initiated)`);
    void sessions
      .startOnboardingThread(jobId, orgId, repoId)
      .catch((err) => this.logger.warn(`onboarding first turn failed for job ${jobId}: ${err}`));
    return { jobId };
  }

  async revalidateRepo(orgId: string, repoId: string): Promise<ConnectedRepo> {
    const repo = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    if (!repo) throw new NotFoundException('repo not found');
    const validation = await this.validateRepo(orgId, repo.slug);
    await this.repos.update(
      { id: repo.id },
      { access_ok: validation.ok, access_checked_at: new Date() },
    );
    if (validation.ok) {
      void this.ensureRepoWebhook(orgId, repo).catch((err) =>
        this.logger.warn(`webhook registration failed for ${repo.id}: ${err}`),
      );
    }
    await this.tryActivate(orgId);
    this.logger.log(
      `revalidated repo ${repo.slug} (${repo.id}) → org ${orgId} (access_ok=${validation.ok})`,
    );
    return {
      id: repo.id,
      slug: repo.slug,
      name: repo.name,
      gitUrl: repo.git_url,
      defaultBranch: repo.default_branch,
      branchPrefix: repo.branch_prefix ?? null,
      defaultAutoMergeMethod: repo.default_auto_merge_method,
      defaultAutoMergeDeleteBranch: repo.default_auto_merge_delete_branch,
      accessOk: validation.ok,
      ...(validation.reason ? { reason: validation.reason } : {}),
    };
  }

  async updateRepo(
    orgId: string,
    repoId: string,
    patch: {
      name?: string;
      defaultBranch?: string;
      branchPrefix?: string;
      defaultAutoMergeMethod?: AutoMergeMethod;
      defaultAutoMergeDeleteBranch?: boolean;
    },
  ): Promise<ConnectedRepo> {
    const repo = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    if (!repo) throw new NotFoundException('repo not found');
    const next: Partial<RepoEntity> = {};
    if (patch.name !== undefined && patch.name.trim()) next.name = patch.name.trim();
    if (patch.defaultBranch !== undefined && patch.defaultBranch.trim()) {
      next.default_branch = patch.defaultBranch.trim();
    }
    if (patch.branchPrefix !== undefined) {
      next.branch_prefix = patch.branchPrefix.trim() || null;
    }
    if (patch.defaultAutoMergeMethod !== undefined) {
      next.default_auto_merge_method = patch.defaultAutoMergeMethod;
    }
    if (patch.defaultAutoMergeDeleteBranch !== undefined) {
      next.default_auto_merge_delete_branch = patch.defaultAutoMergeDeleteBranch;
    }
    if (Object.keys(next).length) await this.repos.update({ id: repo.id }, next);
    const fresh = await this.repos.findOneOrFail({ where: { id: repo.id } });
    return {
      id: fresh.id,
      slug: fresh.slug,
      name: fresh.name,
      gitUrl: fresh.git_url,
      defaultBranch: fresh.default_branch,
      branchPrefix: fresh.branch_prefix ?? null,
      defaultAutoMergeMethod: fresh.default_auto_merge_method,
      defaultAutoMergeDeleteBranch: fresh.default_auto_merge_delete_branch,
      accessOk: fresh.access_ok,
    };
  }

  async listRepoBranches(
    orgId: string,
    repoId: string,
  ): Promise<{ branches: string[]; defaultBranch: string }> {
    const repo = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    if (!repo) throw new NotFoundException('repo not found');
    const parsed = parseGithubRepoUrl(repo.git_url);
    if (!parsed) throw new BadRequestException(`not an HTTPS GitHub URL: ${repo.git_url}`);
    const token = await this.creds.hostGithubToken(orgId);
    if (!token) throw new BadRequestException('no GitHub token set for this org');
    const names = await this.pr.listBranches(token, parsed.owner, parsed.repo);
    const def = repo.default_branch || 'main';
    return {
      branches: [def, ...names.filter((n) => n !== def)],
      defaultBranch: def,
    };
  }

  async disconnectRepo(
    orgId: string,
    repoId: string,
  ): Promise<{ ok: true; threadsDeleted: number }> {
    const repo = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    if (!repo) throw new NotFoundException('repo not found');

    let threadsDeleted = 0;
    for (;;) {
      const batch = await this.jobs.find({
        where: { repo_id: repoId, org_id: orgId },
        select: { id: true },
      });
      if (batch.length === 0) break;
      for (const { id } of batch) {
        await this.jobTeardown.deleteJobDeep(id, orgId);
        threadsDeleted++;
      }
    }

    await this.stimuli.delete({ repo_id: repoId, org_id: orgId });
    await this.decisionRecords.delete({ repo_id: repoId, org_id: orgId });
    await this.sandboxes.delete({ repo_id: repoId, org_id: orgId });
    await this.repos.delete({ id: repoId, org_id: orgId });
    this.logger.log(
      `disconnected repo ${repo.slug} (${repoId}) from org ${orgId} — ${threadsDeleted} thread(s) cascaded`,
    );
    return { ok: true, threadsDeleted };
  }

  async status(orgId: string): Promise<OnboardingStatus> {
    const org = await this.orgs.findOne({ where: { id: orgId } });
    const lifecycle = (org?.status as OrgLifecycle | undefined) ?? 'onboarding';

    const repoConnected = !!(await this.repos.findOne({
      where: { org_id: orgId, access_ok: true },
    }));

    const presence = await this.store.presence(orgId);
    const credRow = await this.orgCreds.findOne({
      where: { org_id: orgId, scope: '*' },
    });
    const steps = {
      repoConnected,
      llmKey: presence.hasAnthropic && !!credRow?.llm_validated_at,
      openaiKey: presence.hasOpenai,
      engineAuth: presence.engineAuthSet,
      githubPat: presence.githubAuthMode === 'app' ? presence.hasGithubApp : presence.hasGithub,
    };
    const missing: OnboardingStep[] = [];
    if (!steps.repoConnected) missing.push('repo');
    if (!steps.llmKey) missing.push('llm_key');
    if (!steps.openaiKey) missing.push('openai_key');
    if (!steps.engineAuth) missing.push('engine_auth');
    if (!steps.githubPat) missing.push('github_pat');
    return { orgId, lifecycle, steps, missing };
  }

  async nextStep(orgId: string): Promise<OnboardingStep | null> {
    const { missing } = await this.status(orgId);
    return missing[0] ?? null;
  }

  async validateRepo(orgId: string, slug: string): Promise<ValidationResult> {
    const repo = await this.repos.findOne({ where: { org_id: orgId, slug } });
    if (!repo?.git_url) return { ok: false, reason: 'no repo configured' };
    const parsed = parseGithubRepoUrl(repo.git_url);
    if (!parsed) return { ok: false, reason: `not an HTTPS GitHub URL: ${repo.git_url}` };
    const token = await this.creds.hostGithubToken(orgId);
    if (!token) return { ok: false, reason: 'no GitHub token set' };
    const info = await this.pr.getRepo(token, parsed.owner, parsed.repo).catch(() => null);
    if (!info) {
      const presence = await this.store.presence(orgId);
      const reason = presence.hasGithubApp
        ? `Atlas's GitHub App can't access ${parsed.owner}/${parsed.repo} — add this repo under the App installation's repository access`
        : `repo unreachable or token lacks access: ${parsed.owner}/${parsed.repo}`;
      return { ok: false, reason };
    }
    return { ok: true };
  }

  async validateLlmKey(orgId: string): Promise<ValidationResult> {
    const key = await this.creds.anthropicKey(orgId);
    if (!key) return { ok: false, reason: 'no Anthropic API key set' };
    try {
      const probe = new ChatAnthropic({
        apiKey: key,
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 1,
        temperature: 0,
      });
      await probe.invoke([{ role: 'user', content: 'ping' }]);
      await this.orgCreds.update({ org_id: orgId, scope: '*' }, { llm_validated_at: new Date() });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: `Anthropic key check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async tryActivate(orgId: string): Promise<OnboardingStatus> {
    const status = await this.status(orgId);
    if (status.missing.length === 0 && status.lifecycle !== 'active') {
      await this.orgs.update({ id: orgId }, { status: 'active' });
      this.logger.log(`org ${orgId} fully configured → active`);
      void this.spawnOnboardingForPendingRepos(orgId).catch((err) =>
        this.logger.warn(`post-activation onboarding spawn failed for org ${orgId}: ${err}`),
      );
      return { ...status, lifecycle: 'active' };
    }
    return status;
  }

  private async spawnOnboardingForPendingRepos(orgId: string): Promise<void> {
    const repos = await this.repos.find({
      where: { org_id: orgId, access_ok: true, onboarding_job_id: IsNull() },
      select: { id: true },
    });
    for (const r of repos) {
      await this.maybeStartRepoOnboarding(orgId, r.id).catch((err) =>
        this.logger.warn(`repo onboarding spawn failed for ${r.id}: ${err}`),
      );
    }
  }

  private async ensureRepoWebhook(orgId: string, repo: RepoEntity): Promise<void> {
    const base = publicBackendBase(this.env);
    if (!base) {
      this.logger.debug(
        `webhook registration skipped for ${repo.slug} — BACKEND_HOST not publicly reachable`,
      );
      return;
    }
    const parsed = parseGithubRepoUrl(repo.git_url);
    if (!parsed) {
      this.logger.warn(
        `webhook registration skipped for ${repo.slug} — not an HTTPS GitHub URL: ${repo.git_url}`,
      );
      return;
    }
    const token = await this.creds.hostGithubToken(orgId);
    if (!token) {
      this.logger.warn(
        `webhook registration skipped for ${repo.slug} — no GitHub token for org ${orgId}`,
      );
      return;
    }
    const secret = this.env.get('GITHUB_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.warn(
        `webhook registration skipped for ${repo.slug} — GITHUB_WEBHOOK_SECRET unset`,
      );
      return;
    }

    const targets = [
      { url: `${base}/webhooks/github/events`, events: WORK_EVENTS },
      { url: `${base}/webhooks/github/state`, events: STATE_EVENTS },
    ];
    let anyNoScope = false;
    let allOk = true;
    for (const t of targets) {
      const outcome = await this.pr
        .ensureWebhook(token, {
          owner: parsed.owner,
          repo: parsed.repo,
          url: t.url,
          secret,
          events: t.events,
        })
        .catch((err) => {
          this.logger.warn(`ensureWebhook error for ${repo.slug} ${t.url}: ${err}`);
          return 'error' as const;
        });
      this.logger.log(`webhook ${t.url} for ${repo.slug} → ${outcome}`);
      if (outcome === 'no-scope') anyNoScope = true;
      if (outcome !== 'created' && outcome !== 'updated') allOk = false;
    }

    const pruned = await this.pr
      .pruneWebhooksExcept(token, {
        owner: parsed.owner,
        repo: parsed.repo,
        urlPrefix: `${base}/`,
        keepUrls: targets.map((t) => t.url),
      })
      .catch((err) => {
        this.logger.warn(`webhook prune error for ${repo.slug}: ${err}`);
        return 0;
      });
    if (pruned > 0) this.logger.log(`pruned ${pruned} stale Atlas webhook(s) for ${repo.slug}`);

    if (anyNoScope) {
      await this.repos.update(
        { id: repo.id },
        {
          webhook_warning:
            'The org GitHub token lacks webhook permission — Atlas could not register the real-time delivery webhook. ' +
            'Classic tokens need the "repo" (or "admin:repo_hook") scope; fine-grained tokens need "Webhooks: Read and write" on the repo. ' +
            'PR state still syncs via the 30-minute poll; grant the permission to enable real-time sync.',
        },
      );
    } else if (allOk) {
      await this.repos.update({ id: repo.id }, { webhook_warning: null });
    }
  }

  async ensureWebhooksForActiveRepos(): Promise<void> {
    const repos = await this.repos.find({ where: { access_ok: true } });
    for (const repo of repos) {
      await this.ensureRepoWebhook(repo.org_id, repo).catch((err) =>
        this.logger.warn(`webhook backfill failed for ${repo.slug}: ${err}`),
      );
    }
  }
}
