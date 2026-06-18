import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  GithubApiService,
  parseGithubRepoUrl,
  type RepoInfo,
} from '../projects/github-api.service';
import { GithubTokenStore } from '../projects/github-token-store';
import { ProjectConflictError, ProjectStore } from '../projects/project-store';
import {
  PROJECT_ONBOARD_PRESENTER,
  type ProjectOnboardPresenter,
} from './project-onboard-presenter.port';

/** A registerable project id: lowercase, leading alphanumeric (the admin DTO's PROJECT_ID rule). */
function toProjectId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/[-]+$/, '');
  return slug || 'project';
}

/** The registrar's resolution result — the durable half, with NO surface concern (so the Slack card
 * adapter can reuse it without a DI cycle through the presenter). */
export type RegisterResult =
  | { status: 'registered'; projectId: string; displayName: string }
  | { status: 'already-registered'; projectId: string }
  | { status: 'needs-token'; reason: string; gitUrl?: string }
  | { status: 'ambiguous'; matches: string[] }
  | { status: 'not-found'; query: string };

/**
 * The presenter-FREE onboarding core: resolve a repo (by name against the default token's accessible
 * repos, or by URL), probe it, and register it read-only when the token can read it. Holds NO
 * reference to the outbound presenter, so BOTH {@link ProjectOnboardService} (the tool's entry point,
 * which adds the card-on-miss behavior) and the Slack onboarding modal's submission handler can use it
 * without the service↔adapter dependency cycle.
 */
@Injectable()
export class ProjectRegistrar {
  constructor(
    private readonly projects: ProjectStore,
    private readonly tokens: GithubTokenStore,
    private readonly github: GithubApiService,
  ) {}

  async resolveAndRegister(input: {
    team: string;
    name?: string;
    url?: string;
  }): Promise<RegisterResult> {
    const token = (
      await this.tokens.resolve(input.team).catch(() => undefined)
    )?.token;

    if (input.url) {
      const parsed = parseGithubRepoUrl(input.url);
      if (!parsed) return { status: 'not-found', query: input.url };
      if (token) {
        const repo = await this.github
          .getRepo(token, parsed.owner, parsed.repo)
          .catch(() => null);
        if (repo) return this.register(input.team, repo);
      }
      return {
        status: 'needs-token',
        reason: token
          ? 'the default token cannot read it (private, or out of scope)'
          : 'no GitHub token is stored for this workspace yet',
        gitUrl: input.url,
      };
    }

    const name = (input.name ?? '').trim();
    if (!name) return { status: 'not-found', query: '' };
    if (!token)
      return {
        status: 'needs-token',
        reason: 'no GitHub token is stored for this workspace yet',
      };
    const matches = await this.github
      .searchAccessibleRepos(token, name)
      .catch(() => [] as RepoInfo[]);
    if (matches.length === 1) return this.register(input.team, matches[0]);
    if (matches.length === 0) return { status: 'not-found', query: name };
    return { status: 'ambiguous', matches: matches.map((m) => m.htmlUrl) };
  }

  /**
   * The modal-submission path: a repo URL plus, optionally, a fresh GitHub token. Stores the token
   * (named; made default only if the workspace has none) and probes/registers WITH it — so a private
   * repo the default token couldn't read gets onboarded via the token Dennis just supplied.
   */
  async completeWithUrl(input: {
    team: string;
    url: string;
    token?: string;
  }): Promise<RegisterResult> {
    const parsed = parseGithubRepoUrl(input.url);
    if (!parsed) return { status: 'not-found', query: input.url };

    let tokenName: string | null = null;
    let probe = (
      await this.tokens.resolve(input.team).catch(() => undefined)
    )?.token;
    if (input.token) {
      tokenName = `onboard-${toProjectId(parsed.repo)}`;
      const noDefault =
        (await this.tokens.listMeta(input.team).catch(() => [])).length === 0;
      await this.tokens.put(input.team, tokenName, input.token, noDefault);
      probe = input.token;
    }
    if (!probe)
      return {
        status: 'needs-token',
        reason: 'no GitHub token was provided',
        gitUrl: input.url,
      };
    const repo = await this.github
      .getRepo(probe, parsed.owner, parsed.repo)
      .catch(() => null);
    if (!repo)
      return {
        status: 'needs-token',
        reason: 'that token still cannot read the repo',
        gitUrl: input.url,
      };
    return this.register(input.team, repo, tokenName);
  }

  /** Register a probed repo read-only. Idempotent on a slug collision (already registered → ok). */
  private async register(
    team: string,
    repo: RepoInfo,
    tokenName: string | null = null,
  ): Promise<RegisterResult> {
    const projectId = toProjectId(repo.name);
    try {
      await this.projects.create({
        teamId: team,
        projectId,
        displayName: repo.name,
        description: repo.description ?? undefined,
        gitUrl: repo.htmlUrl,
        defaultBranch: repo.defaultBranch,
        tokenName,
      });
      return { status: 'registered', projectId, displayName: repo.name };
    } catch (err) {
      if (err instanceof ProjectConflictError)
        return { status: 'already-registered', projectId };
      throw err;
    }
  }
}

/** The outcome `onboard_project` renders — the registrar's result with 'needs-token' resolved into a
 * card disposition ('needs-input': presented or not). */
export type OnboardOutcome =
  | { status: 'registered'; projectId: string; displayName: string }
  | { status: 'already-registered'; projectId: string }
  | { status: 'needs-input'; presented: boolean; reason: string }
  | { status: 'ambiguous'; matches: string[] }
  | { status: 'not-found'; query: string };

/**
 * The tool-facing onboarding entry point — the sibling of {@link SuggestionService}. Wraps the
 * presenter-free {@link ProjectRegistrar}: resolve+register when the default token already reads the
 * repo (the 90% case), otherwise PRESENT a card to collect the missing piece (a token, via the modal).
 * The presenter is `@Optional` (headless binds none → the tool tells Atlas to ask Dennis in chat).
 */
@Injectable()
export class ProjectOnboardService {
  constructor(
    private readonly registrar: ProjectRegistrar,
    @Optional()
    @Inject(PROJECT_ONBOARD_PRESENTER)
    private readonly presenter?: ProjectOnboardPresenter,
  ) {}

  async onboard(input: {
    team: string;
    surfaceId: string;
    proposedBy: string;
    name?: string;
    url?: string;
  }): Promise<OnboardOutcome> {
    const r = await this.registrar.resolveAndRegister({
      team: input.team,
      name: input.name,
      url: input.url,
    });
    if (r.status === 'needs-token')
      return this.presentCard(input, r.gitUrl, r.reason);
    return r;
  }

  private async presentCard(
    input: { team: string; surfaceId: string; name?: string; url?: string },
    gitUrl: string | undefined,
    reason: string,
  ): Promise<OnboardOutcome> {
    if (!this.presenter)
      return { status: 'needs-input', presented: false, reason };
    try {
      await this.presenter.present({
        team: input.team,
        surfaceId: input.surfaceId,
        name: input.name ?? gitUrl ?? 'project',
        gitUrl,
        reason,
      });
      return { status: 'needs-input', presented: true, reason };
    } catch {
      return { status: 'needs-input', presented: false, reason };
    }
  }
}
