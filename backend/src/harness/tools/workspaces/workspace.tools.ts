import { Inject } from '@nestjs/common';
import { DEFAULT_BRANCHING_POLICY } from '@workspace/shared';
import { z } from 'zod';
import { ChannelRegistryService } from '../../channel/channel-registry.service';
import { parseGithubRepo } from '../../projects/git-auth';
import { GithubApiService } from '../../projects/github-api.service';
import { GithubTokenStore } from '../../projects/github-token-store';
import { ProjectStore } from '../../projects/project-store';
import {
  SESSION_REGISTRY,
  type SessionRegistry,
} from '../../sessions/session-registry.port';
import { deriveBranch } from '../../workspaces/branch-policy';
import { ContainerManagerService } from '../../workspaces/container-manager.service';
import { SandboxRegistry } from '../../workspaces/sandbox-registry';
import { WorkspaceGitProvider } from '../../workspaces/workspace-git.provider';
import { WorkspaceReader } from '../../workspaces/workspace-reader';
import { WorkspaceRegistry } from '../../workspaces/workspace-registry';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * A bot's workspace tools — managing the per-branch WORKSTATIONS its sessions run in.
 *
 * A WORKSTATION is a long-lived per-branch sandbox, keyed `(team, project, branch)`. `create_workspace`
 * takes a STRUCTURED INTENT (`{kind, slug?, ticket?}`) and the branch is DERIVED from the project's
 * branching policy — a feature is ONE branch the whole team works directly (no personal branches, no
 * shared-branch merge). Re-entry is idempotent: a second create deriving the same branch reuses the
 * same workstation. All non-terminal on purpose: a bot can chain create_workspace → create_session in
 * one turn (the ToolNode loops until a terminal tool or a plain reply).
 *
 * A sandbox needs a clone URL, so create_workspace requires a REGISTERED project (its GitHub repo); an
 * unregistered project can't be sandboxed and is refused with a clear next step (there is no local
 * fallback). The engine ≠ langgraph half of the policy is enforced where the engine is known — at
 * session creation (CreateSessionTool).
 */

/** Resolve the live channel→project binding (a repo linked earlier THIS turn via onboard_project wouldn't
 * show in the frozen per-turn identity). Only override for channel surfaces — a DM keeps id.project. */
function liveProject(
  channels: ChannelRegistryService,
  id: HarnessToolContext['identity'],
): string {
  return id.isChannel ? channels.projectOf(id.surface) : id.project;
}

const createWorkspaceSchema = z.object({
  kind: z
    .enum(['base', 'feature', 'hotfix'])
    .describe(
      "What kind of workstation: 'feature' = a new feature branch the whole team works directly (give a slug); 'hotfix' = an urgent fix off the default branch (give a ticket); 'base' = work directly on the base/integration branch (no slug needed).",
    ),
  slug: z
    .string()
    .optional()
    .describe(
      "The feature name, kebab-cased into the branch (e.g. 'export-csv' → feature/export-csv). REQUIRED for kind=feature.",
    ),
  ticket: z
    .string()
    .optional()
    .describe(
      'The ticket id this workstation is for (names a hotfix branch; used by branch templates). REQUIRED for kind=hotfix unless a slug is given.',
    ),
});

@HarnessTool()
export class CreateWorkspaceTool implements IHarnessTool<
  typeof createWorkspaceSchema
> {
  readonly name = 'create_workspace';
  readonly refreshesContext = ['work'] as const;
  readonly description =
    "Create (or re-enter) a per-branch WORKSTATION off the project repo — the work area your sessions run in. The branch is DERIVED from a structured intent ({kind: base|feature|hotfix, slug?, ticket?}) and the project's branching policy; a feature is ONE branch the whole team works directly. Re-running with the same intent re-enters the same workstation. Returns the workspace id to open sessions against. Use query_branches first if you're unsure what branch/base to target. Note: a fresh checkout has no installed dependencies; a session can run installs itself if it needs them.";
  readonly schema = createWorkspaceSchema;

  constructor(
    private readonly containers: ContainerManagerService,
    private readonly projects: ProjectStore,
    private readonly tokens: GithubTokenStore,
    private readonly github: GithubApiService,
    private readonly workAreas: WorkspaceRegistry,
    private readonly channels: ChannelRegistryService,
  ) {}

  async execute(
    { kind, slug, ticket }: z.infer<typeof createWorkspaceSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const project = liveProject(this.channels, id);
    try {
      // A sandbox needs a clone URL → the project must be REGISTERED (no local fallback). Load it now;
      // we need its gitUrl/defaultBranch/branchingPolicy to derive the branch.
      const rec = await this.projects
        .get(id.team, project)
        .catch(() => undefined);
      if (!rec) {
        return `Can't create a workspace for ${id.team}/${project}: the project has no registered GitHub repo to clone. Register the project's repo first (onboard_project links this channel's main repo), then create_workspace.`;
      }

      const policy = rec.branchingPolicy ?? DEFAULT_BRANCHING_POLICY;
      const { owner, repo } = parseGithubRepo(rec.gitUrl);

      // Resolve the auto-base ONLY when a rule for this intent actually uses 'auto' (avoids a GitHub
      // round-trip otherwise). pickAutoBase probes dev → develop → staging → the default branch.
      let resolvedAutoBase = rec.defaultBranch;
      // Mirror deriveBranch's own fallback: a custom policy missing this kind uses the DEFAULT rule.
      const rule = policy[kind] ?? DEFAULT_BRANCHING_POLICY[kind];
      if (rulesUseAuto(rule)) {
        const auth = await this.tokens
          .resolve(rec.teamId, rec.tokenName)
          .catch(() => undefined);
        if (auth) {
          resolvedAutoBase = await this.github
            .pickAutoBase(auth.token, { owner, repo }, rec.defaultBranch)
            .catch(() => rec.defaultBranch);
        }
      }

      const { branch, baseRef, upstream } = deriveBranch(
        { kind, ...(slug ? { slug } : {}), ...(ticket ? { ticket } : {}) },
        policy,
        rec.defaultBranch,
        resolvedAutoBase,
      );

      // WORKSTATION: ensure (or re-enter) the per-branch sandbox for (team, project, branch). The daemon
      // checks the branch out at boot from the env we inject (WORKSPACE_BRANCH/BASE_REF/UPSTREAM), so the
      // work area is realized BY THE SANDBOX — there's no host-side createWorktree RPC anymore. The work
      // area is 1:1 with the workstation: its id IS the sandbox uuid (session.workspace_id holds it).
      const sandbox = await this.containers.ensureWorkspace(
        id.team,
        project,
        branch,
        baseRef,
        upstream,
      );
      const workAreaId = sandbox.workspaceId;
      this.workAreas.upsert({
        workAreaId,
        sandboxId: sandbox.workspaceId,
        team: id.team,
        project,
        name: branch,
        ownerBot: id.selfAgent,
        branch,
        baseRef,
        upstream,
      });
      const reentry = `${id.team}/${project}`;
      // Surface where the dev server will be viewable (best-effort: undefined when the port pool was
      // exhausted at create). The agent makes it reachable by running its dev server in the sandbox's inner
      // compose published to 0.0.0.0:7000 (the WORKSPACE_DEV_PORT).
      const devNote =
        sandbox.devPort !== undefined
          ? ` Its dev server is viewable at http://localhost:${sandbox.devPort} once a session runs one inside the sandbox's inner compose published to 0.0.0.0:7000.`
          : '';
      return `Workstation ${workAreaId} is on branch ${branch} (cut from ${baseRef}, PRs into ${upstream}) in the ${reentry} sandbox. Open sessions against it — they share its branch/worktree inside the sandbox; the whole team works this branch directly.${devNote}`;
    } catch (err) {
      return `Couldn't create the workspace: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/** Whether a branch-kind rule resolves any of its refs through the auto-base detector (so we should
 * call pickAutoBase). `name` can also carry `{from}`, which is the resolved `from` ref. */
function rulesUseAuto(rule: { from: string; upstream: string }): boolean {
  return rule.from === 'auto' || rule.upstream === 'auto';
}

const queryBranchesSchema = z.object({});

@HarnessTool()
export class QueryBranchesTool implements IHarnessTool<
  typeof queryBranchesSchema
> {
  readonly name = 'query_branches';
  readonly description =
    "List the project repo's branches plus the recommended auto-base (dev → develop → staging → the default branch) — read-only. Use it before create_workspace to choose your intent: whether a feature branch already exists to re-enter, or what base a new one would cut from.";
  readonly schema = queryBranchesSchema;

  constructor(
    private readonly projects: ProjectStore,
    private readonly tokens: GithubTokenStore,
    private readonly github: GithubApiService,
    private readonly channels: ChannelRegistryService,
  ) {}

  async execute(
    _args: z.infer<typeof queryBranchesSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const project = liveProject(this.channels, id);
    const rec = await this.projects.get(id.team, project).catch(() => undefined);
    if (!rec) {
      return `No registered GitHub repo for ${id.team}/${project} — onboard_project it first.`;
    }
    const auth = await this.tokens
      .resolve(rec.teamId, rec.tokenName)
      .catch(() => undefined);
    if (!auth) {
      return rec.tokenName
        ? `The project's GitHub token "${rec.tokenName}" isn't in the token store — Dennis can add it via the admin API.`
        : 'No default GitHub token is stored — Dennis can add one via the admin API.';
    }
    try {
      const { owner, repo } = parseGithubRepo(rec.gitUrl);
      const [branches, autoBase] = await Promise.all([
        this.github.listBranches(auth.token, { owner, repo }),
        this.github.pickAutoBase(auth.token, { owner, repo }, rec.defaultBranch),
      ]);
      if (branches.length === 0) {
        return `No branches on ${owner}/${repo} (recommended base: ${autoBase}).`;
      }
      const lines = branches.map(
        (b) => `- ${b.name}${b.protected ? ' [protected]' : ''}`,
      );
      return `Branches on ${owner}/${repo} (default ${rec.defaultBranch}, recommended auto-base ${autoBase}):\n${lines.join('\n')}`;
    } catch (err) {
      return `Couldn't list the branches: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

const listWorkspacesSchema = z.object({});

@HarnessTool()
export class ListWorkspacesTool implements IHarnessTool<
  typeof listWorkspacesSchema
> {
  readonly name = 'list_workspaces';
  readonly description =
    "The team's workstations, with each one's branch and open sessions — check here before creating a new workstation you might already have on that branch.";
  readonly schema = listWorkspacesSchema;

  constructor(
    private readonly reader: WorkspaceReader,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  async execute(): Promise<string> {
    const all = this.reader.list();
    if (all.length === 0) return 'No workstations exist yet.';
    const lines = await Promise.all(
      all.map(async (w) => {
        const open = (await this.sessions.list({ workspaceId: w.id })).filter(
          (s) => s.status !== 'closed',
        );
        const sessions = open.length
          ? open.map((s) => `${s.id} (${s.status})`).join(', ')
          : 'none';
        const devNote = w.devUrl ? `; dev server: ${w.devUrl}` : '';
        return `- ${w.id} — branch ${w.branch}${w.ownerBot ? `, created by ${w.ownerBot}` : ''}; open sessions: ${sessions}${devNote}`;
      }),
    );
    return lines.join('\n');
  }
}

const removeWorkspaceSchema = z.object({
  workspaceId: z.string().describe('The workspace id to remove.'),
});

@HarnessTool()
export class RemoveWorkspaceTool implements IHarnessTool<
  typeof removeWorkspaceSchema
> {
  readonly name = 'remove_workspace';
  readonly refreshesContext = ['work'] as const;
  readonly description =
    'Tear down a workstation whose work is fully finished — only after its PR is merged or closed (while the PR is open, keep it so review feedback can be addressed without recreating it). Refused while it still has open sessions — close them first. The branch (and its commits) survive on GitHub; this just destroys the local sandbox.';
  readonly schema = removeWorkspaceSchema;

  constructor(
    private readonly reader: WorkspaceReader,
    private readonly containers: ContainerManagerService,
    private readonly sandboxes: SandboxRegistry,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    private readonly workAreas: WorkspaceRegistry,
  ) {}

  async execute({
    workspaceId,
  }: z.infer<typeof removeWorkspaceSchema>): Promise<string> {
    const ws = this.reader.get(workspaceId);
    if (!ws) return `No workspace "${workspaceId}".`;
    // Policy lives here, not in the lifecycle service: a workstation with open sessions stays.
    const open = (await this.sessions.list({ workspaceId })).filter(
      (s) => s.status !== 'closed',
    );
    if (open.length) {
      return `Can't remove ${workspaceId} — it still has open sessions: ${open
        .map((s) => `${s.id} (${s.status})`)
        .join(', ')}. Close them first.`;
    }
    try {
      // The work area is 1:1 with the workstation: workspaceId IS the sandbox uuid. DESTROY the sandbox
      // (stops+removes the container AND reclaims its inner-docker volume — the disk-leak fix) ONLY when
      // it's a branch-scoped workstation (a non-empty branch label means per-branch identity). A sandbox
      // WITHOUT a branch (predating per-branch identity) keeps today's behavior: just drop the host record.
      const sandbox = this.sandboxes.get(workspaceId);
      if (sandbox && sandbox.branch) {
        await this.containers.destroyWorkspace(workspaceId);
        this.workAreas.remove(workspaceId);
        return `Removed workstation ${workspaceId} (branch ${sandbox.branch}); its sandbox is destroyed. The branch and its commits survive on GitHub.`;
      }
      // Fallback: no branch-scoped sandbox to destroy — just drop the host work-area record.
      this.workAreas.remove(workspaceId);
      const branchNote = ws.branch ? ` Branch ${ws.branch} survives with its commits.` : '';
      return `Removed ${workspaceId}.${branchNote}`;
    } catch (err) {
      return `Couldn't remove ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/**
 * Guard shared by publish/pull: a merge mutates files in the checkout, so it must not run under a
 * live engine turn. Only 'running' blocks — 'idle'/'failed' sessions hold context but execute
 * nothing. (TOCTOU window: a reply could start a turn between this check and the merge — same
 * accepted v0 exposure as remove_workspace's open-session check.)
 */
async function midTurnRefusal(
  sessions: SessionRegistry,
  workspaceId: string,
  verb: string,
): Promise<string | undefined> {
  const running = (await sessions.list({ workspaceId })).filter(
    (s) => s.status === 'running',
  );
  return running.length
    ? `Can't ${verb} while a session is mid-turn in ${workspaceId} (${running
        .map((s) => s.id)
        .join(
          ', ',
        )}) — a merge would mutate files under it. Wait for the report or close it.`
    : undefined;
}

const conflictReply = (
  workspaceId: string,
  verb: string,
  res: { sharedBranch: string; files?: string[] },
): string =>
  `Merge conflict with ${res.sharedBranch} in: ${(res.files ?? []).join(', ') || '(unknown files)'}. The merge is left IN PROGRESS in ${workspaceId} — reply into a session there (mode 'execute') to resolve and commit it, then ${verb} again.`;

const baseConflictReply = (
  workspaceId: string,
  res: { baseBranch?: string; files?: string[] },
): string =>
  `Merge conflict with the base branch ${res.baseBranch ?? '(base)'} in: ${(res.files ?? []).join(', ') || '(unknown files)'}. The merge is left IN PROGRESS in ${workspaceId} — reply into a session there (mode 'execute') to resolve and commit it, then refresh again.`;

const publishWorkspaceSchema = z.object({
  workspaceId: z
    .string()
    .describe('The workspace whose committed work to publish.'),
});

@HarnessTool()
export class PublishWorkspaceTool implements IHarnessTool<
  typeof publishWorkspaceSchema
> {
  readonly name = 'publish_workspace';
  readonly description =
    "Push a workspace's COMMITTED work to origin (GitHub) on its branch, so teammates and Dennis can take it and the PR stays current. The whole team works the one branch — this just pushes it. Only commits publish — have a session commit first. Refused while a session in the workspace is mid-turn.";
  readonly schema = publishWorkspaceSchema;

  constructor(
    private readonly reader: WorkspaceReader,
    private readonly workspaceGit: WorkspaceGitProvider,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  async execute({
    workspaceId,
  }: z.infer<typeof publishWorkspaceSchema>): Promise<string> {
    const ws = this.reader.get(workspaceId);
    if (!ws) return `No workspace "${workspaceId}".`;
    const refusal = await midTurnRefusal(this.sessions, workspaceId, 'publish');
    if (refusal) return refusal;
    try {
      const res = await this.workspaceGit
        .resolve({ team: ws.team, project: ws.project, workspaceId })
        .publish(workspaceId);
      if (!res.integrated) return conflictReply(workspaceId, 'publish', res);
      const dirtyNote = res.dirty
        ? ' Note: the workspace has uncommitted changes — those were NOT published (only commits publish).'
        : '';
      // The remote outcome is always stated — a publish that didn't reach GitHub must never read
      // as done (that's how Dennis ends up reviewing a stale PR).
      const remoteNote = res.remote?.pushed
        ? ` Pushed to GitHub — the PR (if open) is up to date.`
        : ` NOT on GitHub: ${res.remote?.detail ?? 'origin sync did not run'}.`;
      return `Published ${ws.branch}.${remoteNote}${dirtyNote}`;
    } catch (err) {
      return `Couldn't publish ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

const pullWorkspaceSchema = z.object({
  workspaceId: z
    .string()
    .describe("The workspace to pull teammates' latest commits into."),
});

@HarnessTool()
export class PullWorkspaceTool implements IHarnessTool<
  typeof pullWorkspaceSchema
> {
  readonly name = 'pull_workspace';
  readonly description =
    "Pull teammates' latest commits for this branch from origin into a workspace — the whole team works the one branch, so this takes their published work. Refused while a session in the workspace is mid-turn.";
  readonly schema = pullWorkspaceSchema;

  constructor(
    private readonly reader: WorkspaceReader,
    private readonly workspaceGit: WorkspaceGitProvider,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  async execute({
    workspaceId,
  }: z.infer<typeof pullWorkspaceSchema>): Promise<string> {
    const ws = this.reader.get(workspaceId);
    if (!ws) return `No workspace "${workspaceId}".`;
    const refusal = await midTurnRefusal(this.sessions, workspaceId, 'pull');
    if (refusal) return refusal;
    try {
      const res = await this.workspaceGit
        .resolve({ team: ws.team, project: ws.project, workspaceId })
        .pull(workspaceId);
      if (!res.integrated) return conflictReply(workspaceId, 'pull', res);
      return `Pulled the latest ${ws.branch} from origin.${res.originFetched ? '' : ' (origin was not reachable — nothing new pulled.)'}`;
    } catch (err) {
      return `Couldn't pull into ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

const refreshWorkspaceSchema = z.object({
  workspaceId: z
    .string()
    .describe("The workspace to update with the project's base branch."),
});

@HarnessTool()
export class RefreshWorkspaceTool implements IHarnessTool<
  typeof refreshWorkspaceSchema
> {
  readonly name = 'refresh_workspace';
  readonly description =
    "Update a workspace with the latest of the project's base branch (fetches origin and merges it in) — pick up changes merged since the workspace was cut. Execute sessions refresh automatically on start; use this to re-sync mid-work. Refused while a session in the workspace is mid-turn.";
  readonly schema = refreshWorkspaceSchema;

  constructor(
    private readonly reader: WorkspaceReader,
    private readonly workspaceGit: WorkspaceGitProvider,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  async execute({
    workspaceId,
  }: z.infer<typeof refreshWorkspaceSchema>): Promise<string> {
    const ws = this.reader.get(workspaceId);
    if (!ws) return `No workspace "${workspaceId}".`;
    const refusal = await midTurnRefusal(this.sessions, workspaceId, 'refresh');
    if (refusal) return refusal;
    try {
      const res = await this.workspaceGit
        .resolve({ team: ws.team, project: ws.project, workspaceId })
        .refreshFromBase(workspaceId);
      if (res.conflicted) return baseConflictReply(workspaceId, res);
      if (res.refreshed) {
        return `Refreshed ${ws.branch} with ${res.baseBranch}.`;
      }
      return `Did not refresh ${workspaceId}: ${res.detail ?? 'no base branch available'}.`;
    } catch (err) {
      return `Couldn't refresh ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
