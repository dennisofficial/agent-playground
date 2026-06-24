import { ChatAnthropic } from '@langchain/anthropic';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GithubPrService, parseGithubRepoUrl } from '../git';
import { DB_CONNECTION } from '../persistence/database.module';
import { OrgCredentialsEntity, RepoEntity, OrganizationEntity } from '../persistence/entities';
import { CredentialResolver } from './credential-resolver.service';
import { TenantCredentialStore } from './tenant-credential.store';

/** An org's lifecycle, stored on `organizations.status`. */
export type OrgLifecycle = 'onboarding' | 'active' | 'suspended';

/** The ordered onboarding checklist steps (first-unmet is the next thing to do). */
export type OnboardingStep = 'repo' | 'llm_key' | 'engine_auth' | 'github_pat';

/** The derived onboarding state for an org — computed from rows, never a separate source of truth. */
export interface OnboardingStatus {
  orgId: string;
  lifecycle: OrgLifecycle;
  steps: {
    repoConnected: boolean;
    llmKey: boolean;
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
  repoId: string;
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
    private readonly creds: CredentialResolver,
    private readonly store: TenantCredentialStore,
    private readonly pr: GithubPrService,
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
        repoId: '',
        name: '',
        gitUrl: repoUrl,
        defaultBranch: args.baseBranch ?? 'main',
        accessOk: false,
        reason: `not an HTTPS GitHub URL: ${repoUrl}`,
      };
    }
    const repoId = slugifyRepo(parsed.repo);
    const name = args.displayName ?? parsed.repo;
    const baseBranch = args.baseBranch ?? 'main';

    await this.repos.upsert(
      {
        org_id: orgId,
        repo_id: repoId,
        name,
        git_url: repoUrl,
        default_branch: baseBranch,
        token_name: null,
      },
      ['org_id', 'repo_id'],
    );

    const validation = await this.validateRepo(orgId, repoId);
    await this.repos.update(
      { org_id: orgId, repo_id: repoId },
      { access_ok: validation.ok, access_checked_at: new Date() },
    );
    this.logger.log(`connected repo ${repoId} → org ${orgId} (access_ok=${validation.ok})`);

    return {
      repoId,
      name,
      gitUrl: repoUrl,
      defaultBranch: baseBranch,
      accessOk: validation.ok,
      ...(validation.reason ? { reason: validation.reason } : {}),
    };
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
      engineAuth: presence.engineAuthSet,
      githubPat: presence.hasGithub,
    };
    const missing: OnboardingStep[] = [];
    if (!steps.repoConnected) missing.push('repo');
    if (!steps.llmKey) missing.push('llm_key');
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
  async validateRepo(orgId: string, repoId: string): Promise<ValidationResult> {
    const repo = await this.repos.findOne({ where: { org_id: orgId, repo_id: repoId } });
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
      return { ...status, lifecycle: 'active' };
    }
    return status;
  }
}
