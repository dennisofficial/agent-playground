import { Inject } from '@nestjs/common';
import { z } from 'zod';
import {
  SESSION_REGISTRY,
  type SessionRegistry,
} from '../../sessions/session-registry.port';
import { WorkspaceGitProvider } from '../../workspaces/workspace-git.provider';
import { WorkspaceService } from '../../workspaces/workspace.service';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * A bot's workspace tools — managing the isolated work areas its sessions run in. All non-terminal
 * on purpose: a bot can chain create_workspace → create_session inside one turn (the ToolNode loops
 * until a terminal tool or a plain reply).
 */

const createWorkspaceSchema = z.object({
  name: z
    .string()
    .describe(
      'Short name for this work area (slugified into the directory and branch).',
    ),
  branch: z
    .string()
    .optional()
    .describe(
      'Check out this existing branch instead of cutting a fresh one from the base.',
    ),
  shared: z
    .string()
    .optional()
    .describe(
      'Join (or start) a shared integration branch for multi-employee feature work — everyone on the feature passes the SAME name; your personal branch is cut from it.',
    ),
});

@HarnessTool()
export class CreateWorkspaceTool implements IHarnessTool<
  typeof createWorkspaceSchema
> {
  readonly name = 'create_workspace';
  readonly refreshesContext = ['work'] as const;
  readonly description =
    'Create an isolated git workspace off the project repo — the work area your sessions run in. Cuts a fresh branch from the base by default. Returns the workspace id to open sessions against. Note: a fresh checkout has no installed dependencies; a session can run installs itself if it needs them.';
  readonly schema = createWorkspaceSchema;

  constructor(private readonly workspaceGit: WorkspaceGitProvider) {}

  async execute(
    { name, branch, shared }: z.infer<typeof createWorkspaceSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    try {
      const { workspace, warning } = await this.workspaceGit
        .resolve({ team: id.team, project: id.project })
        .create({
          name,
          branch,
          shared,
          ownerBot: id.selfAgent,
          team: id.team,
          project: id.project,
        });
      const sharedNote = workspace.sharedBranch
        ? ` Publishing to shared branch ${workspace.sharedBranch}.`
        : '';
      return `Created ${workspace.id} on branch ${workspace.branch}.${sharedNote}${warning ? ` ${warning}` : ''}`;
    } catch (err) {
      return `Couldn't create the workspace: ${err instanceof Error ? err.message : String(err)}`;
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
    "The team's workspaces, with each one's branch and open sessions — check here before creating a new work area you might already have.";
  readonly schema = listWorkspacesSchema;

  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly workspaceGit: WorkspaceGitProvider,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  async execute(): Promise<string> {
    const all = this.workspaces.list();
    if (all.length === 0) return 'No workspaces exist yet.';
    const lines = await Promise.all(
      all.map(async (w) => {
        const open = (await this.sessions.list({ workspaceId: w.id })).filter(
          (s) => s.status !== 'closed',
        );
        const sessions = open.length
          ? open.map((s) => `${s.id} (${s.status})`).join(', ')
          : 'none';
        // Shared-branch publish state, so "who has published" is readable here instead of being
        // reconstructed from teammates' chat self-reports.
        let sharedNote = '';
        if (w.sharedBranch) {
          const st = await this.workspaceGit
            .resolve({ team: w.team, project: w.project, workspaceId: w.id })
            .sharedStatus(w.id)
            .catch(() => undefined);
          const pub = st
            ? st.published
              ? 'published'
              : 'NOT published'
            : 'state unknown';
          const origin =
            st?.aheadOfOrigin === undefined
              ? 'GitHub state unknown'
              : st.aheadOfOrigin > 0
                ? `${st.aheadOfOrigin} shared commit(s) not on GitHub`
                : 'GitHub in sync';
          sharedNote = `, shared: ${w.sharedBranch} (${pub}; ${origin})`;
        }
        return `- ${w.id} "${w.name}" — branch ${w.branch}${sharedNote}${w.ownerBot ? `, created by ${w.ownerBot}` : ''}; open sessions: ${sessions}`;
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
    'Remove a workspace whose work is fully finished — only after its PR is merged or closed (while the PR is open, keep the workspace so review feedback can be addressed without recreating it). Refused while it still has open sessions — close them first. The branch (and its commits) survive.';
  readonly schema = removeWorkspaceSchema;

  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly workspaceGit: WorkspaceGitProvider,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  async execute({
    workspaceId,
  }: z.infer<typeof removeWorkspaceSchema>): Promise<string> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return `No workspace "${workspaceId}".`;
    // Policy lives here, not in the git-only service: a workspace with open sessions stays.
    const open = (await this.sessions.list({ workspaceId })).filter(
      (s) => s.status !== 'closed',
    );
    if (open.length) {
      return `Can't remove ${workspaceId} — it still has open sessions: ${open
        .map((s) => `${s.id} (${s.status})`)
        .join(', ')}. Close them first.`;
    }
    try {
      await this.workspaceGit
        .resolve({ team: ws.team, project: ws.project, workspaceId })
        .remove(workspaceId);
      return `Removed ${workspaceId}. Branch ${ws.branch} survives with its commits.`;
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
    "Publish a workspace's COMMITTED work onto its shared integration branch so teammates and Dennis can take it. Fast-forwards when possible, otherwise merges teammates' work in first; when the project has a registered GitHub repo the shared branch is pushed to GitHub too (the result says whether that happened). Only commits publish — have a session commit first. Refused while a session in the workspace is mid-turn.";
  readonly schema = publishWorkspaceSchema;

  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly workspaceGit: WorkspaceGitProvider,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  async execute({
    workspaceId,
  }: z.infer<typeof publishWorkspaceSchema>): Promise<string> {
    const ws = this.workspaces.get(workspaceId);
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
      return `Published ${ws.branch} → ${res.sharedBranch}.${remoteNote}${dirtyNote}`;
    } catch (err) {
      return `Couldn't publish ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

const pullWorkspaceSchema = z.object({
  workspaceId: z
    .string()
    .describe('The workspace to merge the shared branch into.'),
});

@HarnessTool()
export class PullWorkspaceTool implements IHarnessTool<
  typeof pullWorkspaceSchema
> {
  readonly name = 'pull_workspace';
  readonly description =
    "Merge the shared integration branch into a workspace — take teammates' published work. Refused while a session in the workspace is mid-turn.";
  readonly schema = pullWorkspaceSchema;

  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly workspaceGit: WorkspaceGitProvider,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  async execute({
    workspaceId,
  }: z.infer<typeof pullWorkspaceSchema>): Promise<string> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return `No workspace "${workspaceId}".`;
    const refusal = await midTurnRefusal(this.sessions, workspaceId, 'pull');
    if (refusal) return refusal;
    try {
      const res = await this.workspaceGit
        .resolve({ team: ws.team, project: ws.project, workspaceId })
        .pull(workspaceId);
      if (!res.integrated) return conflictReply(workspaceId, 'pull', res);
      return `Pulled ${res.sharedBranch} into ${ws.branch}.${res.originFetched ? ' (Shared branch synced from GitHub first.)' : ' (Local shared branch only — origin was not synced.)'}`;
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
    private readonly workspaces: WorkspaceService,
    private readonly workspaceGit: WorkspaceGitProvider,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  async execute({
    workspaceId,
  }: z.infer<typeof refreshWorkspaceSchema>): Promise<string> {
    const ws = this.workspaces.get(workspaceId);
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
