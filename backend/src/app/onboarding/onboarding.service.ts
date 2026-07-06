import { ChatAnthropic } from '@langchain/anthropic';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { GithubPrService, parseGithubRepoUrl } from '../git';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  OrganizationEntity,
  OrgCredentialsEntity,
  RepoEntity,
  StimulusEntity,
  JobEntity,
  JobSandboxEntity,
} from '../persistence/entities';
import { CredentialResolver } from './credential-resolver.service';
import { TenantCredentialStore } from './tenant-credential.store';

/** An org's lifecycle, stored on `organizations.status`. */
export type OrgLifecycle = 'onboarding' | 'active' | 'suspended';

/** The ordered onboarding checklist steps (first-unmet is the next thing to do). */
export type OnboardingStep = 'repo' | 'llm_key' | 'openai_key' | 'engine_auth' | 'github_pat';

/** The derived onboarding state for an org — computed from rows, never a separate source of truth. */
export interface OnboardingStatus {
  orgId: string;
  lifecycle: OrgLifecycle;
  steps: {
    repoConnected: boolean;
    llmKey: boolean;
    /** The OpenAI key — powers pgvector memory embeddings AND the per-repo ccc code index. Required. */
    openaiKey: boolean;
    engineAuth: boolean;
    githubPat: boolean;
  };
  /** Unmet steps in order — `missing[0]` is the next thing to do; empty → ready to activate. */
  missing: OnboardingStep[];
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** Connect a GitHub repo to an org (the thing that makes a repo available for threads). */
export interface ConnectRepoArgs {
  orgId: string;
  /** HTTPS GitHub URL for the repo. */
  repoUrl: string;
  baseBranch?: string;
  /** Display name; defaults to the GitHub repo name. */
  displayName?: string;
}

export interface ConnectedRepo {
  /** The repo's uuid id (the API + child rows reference this). */
  id: string;
  /** The URL-safe slug (the clone/worktree/UX identity). */
  slug: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
  accessOk: boolean;
  reason?: string;
}

/** Slugify a repo name into a URL-safe, org-unique handle. */
export function slugifyRepo(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'repo'
  );
}

/**
 * The onboarding state machine + repo connection — the layer that gets an org from created → fully
 * configured → active, and connects a GitHub repo so threads can be opened against it. Checklist state
 * is DERIVED from the existing rows (credentials presence + connected/validated repo + the org's
 * `organizations.status` lifecycle), never a new table.
 */
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
    @InjectRepository(StimulusEntity, DB_CONNECTION)
    private readonly stimuli: Repository<StimulusEntity>,
    @InjectRepository(DecisionRecordEntity, DB_CONNECTION)
    private readonly decisionRecords: Repository<DecisionRecordEntity>,
    @InjectRepository(JobSandboxEntity, DB_CONNECTION)
    private readonly sandboxes: Repository<JobSandboxEntity>,
    private readonly creds: CredentialResolver,
    private readonly store: TenantCredentialStore,
    private readonly pr: GithubPrService,
    // `JobLifecycleService` is resolved LAZILY in `disconnectRepo` via this ref + a dynamic
    // `import()`. A STATIC import of the driver service would close an ES module cycle
    // (onboarding.service → driver/job-lifecycle → onboarding barrel → onboarding.service). `ModuleRef`
    // is core (no module dependency) and the dynamic import is evaluated after boot — same pattern as
    // `OrganizationService.deleteOrg`.
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Idempotently connect a GitHub repo to an org: derive the slug, upsert the `repos` row, then
   * probe access with the org's GitHub token and persist the validated state (`access_ok`). A repo is
   * only counted toward onboarding once `access_ok` is true.
   */
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
        accessOk: false,
        reason: `not an HTTPS GitHub URL: ${repoUrl}`,
      };
    }
    const slug = slugifyRepo(parsed.repo);
    const name = args.displayName ?? parsed.repo;
    const baseBranch = args.baseBranch ?? 'main';

    // Upsert by the org-unique slug; the surrogate uuid `id` is DB-generated (or kept on conflict).
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
    const repo = await this.repos.findOneOrFail({ where: { org_id: orgId, slug } });

    const validation = await this.validateRepo(orgId, slug);
    await this.repos.update(
      { id: repo.id },
      { access_ok: validation.ok, access_checked_at: new Date() },
    );
    this.logger.log(`connected repo ${slug} (${repo.id}) → org ${orgId} (access_ok=${validation.ok})`);

    // Once a repo is reachable AND the org can actually run Atlas, kick a one-off repo-onboarding thread
    // (idempotent — won't re-spawn). Fire-and-forget so connect returns immediately. Covers re-connecting a
    // new repo to an already-active org; the first repo on a not-yet-runnable org is covered by tryActivate.
    if (validation.ok) {
      void this.maybeStartRepoOnboarding(orgId, repo.id).catch((err) =>
        this.logger.warn(`repo onboarding spawn failed for ${repo.id}: ${err}`),
      );
    }

    return {
      id: repo.id,
      slug,
      name,
      gitUrl: repoUrl,
      defaultBranch: baseBranch,
      accessOk: validation.ok,
      ...(validation.reason ? { reason: validation.reason } : {}),
    };
  }

  /**
   * Spawn the one-off repo-ONBOARDING thread (Atlas-run `claude init`) for a connected repo — but only when
   * (a) the org is RUNNABLE (keys + engine auth + GitHub PAT present, so the brain can actually run), (b)
   * the repo's access is validated, and (c) it hasn't been onboarded already. Idempotency + the
   * re-spawn guard are the `repos.onboarding_job_id` marker, set under a conditional UPDATE so two
   * concurrent triggers (connectRepo + tryActivate) can't double-spawn. Best-effort + fire-and-forget by
   * the callers. The brain/store + session manager are resolved LAZILY (the same module-cycle avoidance
   * `disconnectRepo` uses — onboarding → brain would otherwise close an ES module cycle).
   */
  async maybeStartRepoOnboarding(orgId: string, repoId: string): Promise<void> {
    const repo = await this.repos.findOne({ where: { id: repoId, org_id: orgId } });
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

    // Claim the spawn: only the trigger that flips `onboarding_job_id` from NULL wins; a loser deletes
    // its orphan thread row and bails (no double onboarding).
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

  /**
   * Operator-initiated (RE-)ONBOARD of an already-connected repo — the explicit counterpart to the
   * automatic {@link maybeStartRepoOnboarding}. Unlike the auto path it does NOT bail on the
   * `onboarding_job_id` re-spawn guard: it spawns a FRESH onboarding thread and overwrites the marker,
   * so it works for repos connected before onboarding existed, repos already onboarded (re-derive config
   * after the repo changed), or repos whose prior onboarding thread is gone. Requires the org to be
   * runnable (keys + engine auth + GitHub PAT) and the repo's access validated. Returns the new thread id
   * so the UI can deep-link straight into it. Org-scoped (404 on a cross-tenant id).
   */
  async reonboardRepo(orgId: string, repoId: string): Promise<{ jobId: string }> {
    const repo = await this.repos.findOne({ where: { id: repoId, org_id: orgId } });
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
        'Finish org setup (Anthropic key, OpenAI key, engine auth, GitHub PAT) before onboarding a repo.',
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
    // Explicit operator action — overwrite the marker (no first-time guard); the prior onboarding thread,
    // if any, stays as history.
    await this.repos.update({ id: repoId, org_id: orgId }, { onboarding_job_id: jobId });
    this.logger.log(`re-onboarding thread ${jobId} for ${orgId}/${repo.slug} (operator-initiated)`);
    // Fire-and-forget: the first turn provisions the sandbox and runs a full brain turn (minutes) — the
    // HTTP caller only needs the job id to deep-link into the thread and watch it live.
    void sessions.startOnboardingThread(jobId, orgId, repoId).catch((err) =>
      this.logger.warn(`onboarding first turn failed for job ${jobId}: ${err}`),
    );
    return { jobId };
  }

  /**
   * Re-probe a connected repo's GitHub access with the org's current token and persist the result
   * (`access_ok` + `access_checked_at`). Surfaces a rotated/expired PAT without a full reconnect; tries
   * to activate the org in case access just came good. Scoped to the org (404 on a cross-tenant id).
   */
  async revalidateRepo(orgId: string, repoId: string): Promise<ConnectedRepo> {
    const repo = await this.repos.findOne({ where: { id: repoId, org_id: orgId } });
    if (!repo) throw new NotFoundException('repo not found');
    const validation = await this.validateRepo(orgId, repo.slug);
    await this.repos.update(
      { id: repo.id },
      { access_ok: validation.ok, access_checked_at: new Date() },
    );
    await this.tryActivate(orgId);
    this.logger.log(`revalidated repo ${repo.slug} (${repo.id}) → org ${orgId} (access_ok=${validation.ok})`);
    return {
      id: repo.id,
      slug: repo.slug,
      name: repo.name,
      gitUrl: repo.git_url,
      defaultBranch: repo.default_branch,
      accessOk: validation.ok,
      ...(validation.reason ? { reason: validation.reason } : {}),
    };
  }

  /**
   * Update a connected repo's metadata — display name and/or base branch. Pure metadata, no GitHub call
   * (use `revalidateRepo` to re-check access). Scoped to the org (404 on a cross-tenant id).
   */
  async updateRepo(
    orgId: string,
    repoId: string,
    patch: { name?: string; defaultBranch?: string },
  ): Promise<ConnectedRepo> {
    const repo = await this.repos.findOne({ where: { id: repoId, org_id: orgId } });
    if (!repo) throw new NotFoundException('repo not found');
    const next: Partial<RepoEntity> = {};
    if (patch.name !== undefined && patch.name.trim()) next.name = patch.name.trim();
    if (patch.defaultBranch !== undefined && patch.defaultBranch.trim()) {
      next.default_branch = patch.defaultBranch.trim();
    }
    if (Object.keys(next).length) await this.repos.update({ id: repo.id }, next);
    const fresh = await this.repos.findOneOrFail({ where: { id: repo.id } });
    return {
      id: fresh.id,
      slug: fresh.slug,
      name: fresh.name,
      gitUrl: fresh.git_url,
      defaultBranch: fresh.default_branch,
      accessOk: fresh.access_ok,
    };
  }

  /**
   * List a connected repo's branches with the org's GitHub token — the create-job base-branch picker.
   * The repo's configured default branch is surfaced first, then the rest in GitHub's order (de-duped).
   * Scoped to the org (404 on a cross-tenant id).
   */
  async listRepoBranches(
    orgId: string,
    repoId: string,
  ): Promise<{ branches: string[]; defaultBranch: string }> {
    const repo = await this.repos.findOne({ where: { id: repoId, org_id: orgId } });
    if (!repo) throw new NotFoundException('repo not found');
    const parsed = parseGithubRepoUrl(repo.git_url);
    if (!parsed) throw new BadRequestException(`not an HTTPS GitHub URL: ${repo.git_url}`);
    const token = await this.creds.githubToken(orgId);
    if (!token) throw new BadRequestException('no GitHub token set for this org');
    const names = await this.pr.listBranches(token, parsed.owner, parsed.repo);
    const def = repo.default_branch || 'main';
    return { branches: [def, ...names.filter((n) => n !== def)], defaultBranch: def };
  }

  /**
   * Disconnect a repo from the org, CASCADE-deleting everything under it — mirroring
   * `OrganizationService.deleteOrg` (and consistent with single-thread `deleteJobDeep`). The operator
   * is warned in the UI before this runs; here we just tear it all down. Scoped to the org.
   *
   * The repo's threads are deep-deleted in a DRAIN loop (re-query until none remain) rather than a single
   * snapshot: threads can be created from several paths, and the live schema has NO foreign keys, so a
   * thread inserted mid-cascade would otherwise orphan. Each create path inserts one row between awaits,
   * so the loop converges immediately. The repo row stays present through the drain so each
   * `deleteJobDeep` can still resolve repo metadata for worktree/container teardown.
   */
  async disconnectRepo(orgId: string, repoId: string): Promise<{ ok: true; threadsDeleted: number }> {
    const repo = await this.repos.findOne({ where: { id: repoId, org_id: orgId } });
    if (!repo) throw new NotFoundException('repo not found');

    // Resolve the driver service lazily (see the constructor note on the module cycle). `strict: false`
    // searches the whole app; the `.js` extension is required for a relative dynamic `import()` under
    // `moduleResolution: nodenext`.
    const { JobLifecycleService } = await import('../driver/job-lifecycle.service.js');
    const lifecycle = this.moduleRef.get(JobLifecycleService, { strict: false });
    let threadsDeleted = 0;
    for (;;) {
      const batch = await this.jobs.find({
        where: { repo_id: repoId, org_id: orgId },
        select: { id: true },
      });
      if (batch.length === 0) break;
      for (const { id } of batch) {
        await lifecycle.deleteJobDeep(id, orgId);
        threadsDeleted++;
      }
    }

    // Sweep repo-scoped rows not tied to a thread (parked event stimuli / decision records), any leftover
    // sandboxes, then the repo row itself.
    await this.stimuli.delete({ repo_id: repoId, org_id: orgId });
    await this.decisionRecords.delete({ repo_id: repoId, org_id: orgId });
    await this.sandboxes.delete({ repo_id: repoId, org_id: orgId });
    await this.repos.delete({ id: repoId, org_id: orgId });
    this.logger.log(
      `disconnected repo ${repo.slug} (${repoId}) from org ${orgId} — ${threadsDeleted} thread(s) cascaded`,
    );
    return { ok: true, threadsDeleted };
  }

  /** The derived onboarding checklist for an org. */
  async status(orgId: string): Promise<OnboardingStatus> {
    const org = await this.orgs.findOne({ where: { id: orgId } });
    const lifecycle = (org?.status as OrgLifecycle | undefined) ?? 'onboarding';

    const repoConnected = !!(await this.repos.findOne({
      where: { org_id: orgId, access_ok: true },
    }));

    const presence = await this.store.presence(orgId);
    const credRow = await this.orgCreds.findOne({ where: { org_id: orgId, scope: '*' } });
    const steps = {
      repoConnected,
      // The Anthropic key must be PRESENT and validated (1-token probe) to count.
      llmKey: presence.hasAnthropic && !!credRow?.llm_validated_at,
      // The OpenAI key is REQUIRED — it powers both pgvector memory AND the per-repo ccc code index
      // (cloud embeddings). Presence is enough (no separate validation gate today).
      openaiKey: presence.hasOpenai,
      engineAuth: presence.engineAuthSet,
      githubPat: presence.hasGithub,
    };
    const missing: OnboardingStep[] = [];
    if (!steps.repoConnected) missing.push('repo');
    if (!steps.llmKey) missing.push('llm_key');
    if (!steps.openaiKey) missing.push('openai_key');
    if (!steps.engineAuth) missing.push('engine_auth');
    if (!steps.githubPat) missing.push('github_pat');
    return { orgId, lifecycle, steps, missing };
  }

  /** The first unmet step (what the onboarding UX should ask for next), or null when complete. */
  async nextStep(orgId: string): Promise<OnboardingStep | null> {
    const { missing } = await this.status(orgId);
    return missing[0] ?? null;
  }

  /** Probe that the repo is reachable with the org's token (fails fast on a bad PAT/url). */
  async validateRepo(orgId: string, slug: string): Promise<ValidationResult> {
    const repo = await this.repos.findOne({ where: { org_id: orgId, slug } });
    if (!repo?.git_url) return { ok: false, reason: 'no repo configured' };
    const parsed = parseGithubRepoUrl(repo.git_url);
    if (!parsed) return { ok: false, reason: `not an HTTPS GitHub URL: ${repo.git_url}` };
    const token = await this.creds.githubToken(orgId);
    if (!token) return { ok: false, reason: 'no GitHub token set' };
    const info = await this.pr.getRepo(token, parsed.owner, parsed.repo).catch(() => null);
    if (!info) {
      return { ok: false, reason: `repo unreachable or token lacks access: ${parsed.owner}/${parsed.repo}` };
    }
    return { ok: true };
  }

  /**
   * Probe the org's Anthropic key with a 1-token call so a bad key surfaces at onboarding, not mid-build.
   * On success, stamps `llm_validated_at` so the checklist counts the key as validated.
   */
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

  /** Flip the org to `active` once every checklist step is met (no-op otherwise). Returns the status. */
  async tryActivate(orgId: string): Promise<OnboardingStatus> {
    const status = await this.status(orgId);
    if (status.missing.length === 0 && status.lifecycle !== 'active') {
      await this.orgs.update({ id: orgId }, { status: 'active' });
      this.logger.log(`org ${orgId} fully configured → active`);
      // The org just became runnable — kick onboarding for any connected-but-not-yet-onboarded repo (this
      // is the path that covers the FIRST repo, connected before the credentials were in place). Idempotent
      // + fire-and-forget; never blocks activation.
      void this.spawnOnboardingForPendingRepos(orgId).catch((err) =>
        this.logger.warn(`post-activation onboarding spawn failed for org ${orgId}: ${err}`),
      );
      return { ...status, lifecycle: 'active' };
    }
    return status;
  }

  /** Trigger `maybeStartRepoOnboarding` for every access_ok repo of an org that hasn't been onboarded yet. */
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
}
