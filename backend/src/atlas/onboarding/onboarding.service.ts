import { ChatAnthropic } from '@langchain/anthropic';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GithubPrService, parseGithubRepoUrl } from '../git';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasChannel, AtlasProject, AtlasTeam } from '../persistence/entities';
import { CredentialResolver } from './credential-resolver.service';
import { TenantCredentialStore } from './tenant-credential.store';

/** A tenant's lifecycle, stored on `atlas_teams.status`. */
export type TeamLifecycle = 'pending' | 'onboarding' | 'active' | 'suspended';

/** The ordered onboarding checklist steps (first-unmet is the next thing to do). */
export type OnboardingStep =
  | 'install'
  | 'bind_channel'
  | 'llm_key'
  | 'engine_auth'
  | 'github_pat';

/** The derived onboarding state for a tenant — computed from rows, never a separate source of truth. */
export interface OnboardingStatus {
  teamId: string;
  lifecycle: TeamLifecycle;
  steps: {
    installed: boolean;
    channelBound: boolean;
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

/** Bind a Slack channel to a project/repo (the thing that makes inbound messages route). */
export interface BindChannelArgs {
  teamId: string;
  projectId: string;
  /** The surface-native channel id (e.g. Slack 'C042'). */
  channelRef: string;
  /** HTTPS GitHub URL for the project (required — a channel binds to a repo). */
  repoUrl: string;
  baseBranch?: string;
  displayName?: string;
  /** Mark the tenant `active` immediately (the test-bridge / admin path); else preserve/`onboarding`. */
  activate?: boolean;
}

/**
 * The onboarding state machine + channel binding — the orthogonal layer that gets a tenant from
 * installed → fully-configured → active, and (the fix for "unregistered channel ignored") binds a Slack
 * channel to a GitHub repo so `ChatStimulusBridge` routes its messages. Checklist state is DERIVED from
 * the existing rows (credentials presence + channel/project + `atlas_teams.status`), not a new table.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    @InjectRepository(AtlasTeam, ATLAS_CONNECTION)
    private readonly teams: Repository<AtlasTeam>,
    @InjectRepository(AtlasProject, ATLAS_CONNECTION)
    private readonly projects: Repository<AtlasProject>,
    @InjectRepository(AtlasChannel, ATLAS_CONNECTION)
    private readonly channels: Repository<AtlasChannel>,
    private readonly creds: CredentialResolver,
    private readonly store: TenantCredentialStore,
    private readonly pr: GithubPrService,
  ) {}

  /**
   * Idempotently bind a channel to a project/repo: upsert `atlas_teams` + `atlas_projects` (repo + base)
   * + find-or-create the 1:1 `atlas_channels` row and point its `surface_channel_ref` at the channel.
   * THIS fixes the original symptom — `ChatStimulusBridge` keys on `(team_id, surface_channel_ref)`.
   * Preserves an existing team's status on re-bind (a repo re-point doesn't reset `active`→`onboarding`).
   */
  async bindChannel(args: BindChannelArgs): Promise<{ channelId: string }> {
    const { teamId, projectId, channelRef, repoUrl } = args;
    const baseBranch = args.baseBranch ?? 'main';

    const existingTeam = await this.teams.findOne({ where: { team_id: teamId } });
    const status: TeamLifecycle = args.activate
      ? 'active'
      : ((existingTeam?.status as TeamLifecycle | undefined) ?? 'onboarding');
    await this.teams.upsert(
      { team_id: teamId, team_name: existingTeam?.team_name ?? teamId, status },
      ['team_id'],
    );

    await this.projects.upsert(
      {
        team_id: teamId,
        project_id: projectId,
        display_name: args.displayName ?? projectId,
        description: null,
        git_url: repoUrl,
        default_branch: baseBranch,
        token_name: null,
      },
      ['team_id', 'project_id'],
    );

    // Channel is 1:1 with the project via UNIQUE(team_id, project_id), but its PK is a generated uuid —
    // so find-or-create (we can't upsert on the unique pair), then point the surface ref.
    let channel = await this.channels.findOne({
      where: { team_id: teamId, project_id: projectId },
    });
    if (channel) {
      channel.surface_channel_ref = channelRef;
      channel.display_name = args.displayName ?? channelRef;
      channel = await this.channels.save(channel);
    } else {
      channel = await this.channels.save(
        this.channels.create({
          team_id: teamId,
          project_id: projectId,
          surface_channel_ref: channelRef,
          display_name: args.displayName ?? channelRef,
        }),
      );
    }
    this.logger.log(`bound channel ${channelRef} → ${teamId}/${projectId} (channel ${channel.id})`);
    return { channelId: channel.id };
  }

  /** The derived onboarding checklist for a tenant. */
  async status(teamId: string): Promise<OnboardingStatus> {
    const team = await this.teams.findOne({ where: { team_id: teamId } });
    const installed = !!team;
    const lifecycle = (team?.status as TeamLifecycle | undefined) ?? 'pending';

    // channelBound = at least one channel with a surface ref whose project has a repo.
    const channels = await this.channels.find({ where: { team_id: teamId } });
    let channelBound = false;
    for (const ch of channels) {
      if (!ch.surface_channel_ref) continue;
      const proj = await this.projects.findOne({
        where: { team_id: teamId, project_id: ch.project_id },
      });
      if (proj?.git_url) {
        channelBound = true;
        break;
      }
    }

    const presence = await this.store.presence(teamId);
    const steps = {
      installed,
      channelBound,
      llmKey: presence.hasAnthropic,
      engineAuth: presence.engineAuthSet,
      githubPat: presence.hasGithub,
    };
    const missing: OnboardingStep[] = [];
    if (!steps.installed) missing.push('install');
    if (!steps.channelBound) missing.push('bind_channel');
    if (!steps.llmKey) missing.push('llm_key');
    if (!steps.engineAuth) missing.push('engine_auth');
    if (!steps.githubPat) missing.push('github_pat');
    return { teamId, lifecycle, steps, missing };
  }

  /** The first unmet step (what the onboarding UX should ask for next), or null when complete. */
  async nextStep(teamId: string): Promise<OnboardingStep | null> {
    const { missing } = await this.status(teamId);
    return missing[0] ?? null;
  }

  /** Probe that the project's repo is reachable with the tenant's token (fails fast on a bad PAT/url). */
  async validateRepo(teamId: string, projectId: string): Promise<ValidationResult> {
    const project = await this.projects.findOne({
      where: { team_id: teamId, project_id: projectId },
    });
    if (!project?.git_url) return { ok: false, reason: 'no repo configured for this project' };
    const parsed = parseGithubRepoUrl(project.git_url);
    if (!parsed) return { ok: false, reason: `not an HTTPS GitHub URL: ${project.git_url}` };
    const token = await this.creds.githubToken(teamId);
    if (!token) return { ok: false, reason: 'no GitHub token set' };
    const info = await this.pr.getRepo(token, parsed.owner, parsed.repo).catch(() => null);
    if (!info) {
      return { ok: false, reason: `repo unreachable or token lacks access: ${parsed.owner}/${parsed.repo}` };
    }
    return { ok: true };
  }

  /** Probe the tenant's Anthropic key with a 1-token call so a bad key surfaces at onboarding, not mid-build. */
  async validateLlmKey(teamId: string): Promise<ValidationResult> {
    const key = await this.creds.anthropicKey(teamId);
    if (!key) return { ok: false, reason: 'no Anthropic API key set' };
    try {
      const probe = new ChatAnthropic({
        apiKey: key,
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 1,
        temperature: 0,
      });
      await probe.invoke([{ role: 'user', content: 'ping' }]);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: `Anthropic key check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** Flip the tenant to `active` once every checklist step is met (no-op otherwise). Returns the status. */
  async tryActivate(teamId: string): Promise<OnboardingStatus> {
    const status = await this.status(teamId);
    if (status.missing.length === 0 && status.lifecycle !== 'active') {
      await this.teams.update({ team_id: teamId }, { status: 'active' });
      this.logger.log(`tenant ${teamId} fully configured → active`);
      return { ...status, lifecycle: 'active' };
    }
    return status;
  }
}
