import { Inject } from '@nestjs/common';
import { z } from 'zod';
import {
  SESSION_REGISTRY,
  type SessionRegistry,
} from '../../sessions/session-registry.port';
import { WorktreeService } from '../../worktrees/worktree.service';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * A bot's worktree tools — managing the isolated work areas its sessions run in. All non-terminal
 * on purpose: a bot can chain create_worktree → create_session inside one turn (the ToolNode loops
 * until a terminal tool or a plain reply).
 */

const createWorktreeSchema = z.object({
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
export class CreateWorktreeTool implements IHarnessTool<
  typeof createWorktreeSchema
> {
  readonly name = 'create_worktree';
  readonly description =
    'Create an isolated git worktree off the project repo — the work area your sessions run in. Cuts a fresh branch from the base by default. Returns the worktree id to open sessions against. Note: a fresh checkout has no installed dependencies; a session can run installs itself if it needs them.';
  readonly schema = createWorktreeSchema;

  constructor(private readonly worktrees: WorktreeService) {}

  async execute(
    { name, branch, shared }: z.infer<typeof createWorktreeSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    try {
      const { worktree, warning } = await this.worktrees.create({
        name,
        branch,
        shared,
        ownerBot: id.selfAgent,
        team: id.team,
        project: id.project,
      });
      const sharedNote = worktree.sharedBranch
        ? ` Publishing to shared branch ${worktree.sharedBranch}.`
        : '';
      return `Created ${worktree.id} on branch ${worktree.branch}.${sharedNote}${warning ? ` ${warning}` : ''}`;
    } catch (err) {
      return `Couldn't create the worktree: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

const listWorktreesSchema = z.object({});

@HarnessTool()
export class ListWorktreesTool implements IHarnessTool<
  typeof listWorktreesSchema
> {
  readonly name = 'list_worktrees';
  readonly description =
    "The team's worktrees, with each one's branch and open sessions — check here before creating a new work area you might already have.";
  readonly schema = listWorktreesSchema;

  constructor(
    private readonly worktrees: WorktreeService,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  async execute(): Promise<string> {
    const all = this.worktrees.list();
    if (all.length === 0) return 'No worktrees exist yet.';
    const lines = await Promise.all(
      all.map(async (w) => {
        const open = (await this.sessions.list({ worktreeId: w.id })).filter(
          (s) => s.status !== 'closed',
        );
        const sessions = open.length
          ? open.map((s) => `${s.id} (${s.status})`).join(', ')
          : 'none';
        // Shared-branch publish state, so "who has published" is readable here instead of being
        // reconstructed from teammates' chat self-reports.
        let sharedNote = '';
        if (w.sharedBranch) {
          const st = await this.worktrees
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

const removeWorktreeSchema = z.object({
  worktreeId: z.string().describe('The worktree id to remove.'),
});

@HarnessTool()
export class RemoveWorktreeTool implements IHarnessTool<
  typeof removeWorktreeSchema
> {
  readonly name = 'remove_worktree';
  readonly description =
    'Remove a worktree whose work is fully finished. Refused while it still has open sessions — close them first. The branch (and its commits) survive.';
  readonly schema = removeWorktreeSchema;

  constructor(
    private readonly worktrees: WorktreeService,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  async execute({
    worktreeId,
  }: z.infer<typeof removeWorktreeSchema>): Promise<string> {
    const wt = this.worktrees.get(worktreeId);
    if (!wt) return `No worktree "${worktreeId}".`;
    // Policy lives here, not in the git-only service: a worktree with open sessions stays.
    const open = (await this.sessions.list({ worktreeId })).filter(
      (s) => s.status !== 'closed',
    );
    if (open.length) {
      return `Can't remove ${worktreeId} — it still has open sessions: ${open
        .map((s) => `${s.id} (${s.status})`)
        .join(', ')}. Close them first.`;
    }
    try {
      await this.worktrees.remove(worktreeId);
      return `Removed ${worktreeId}. Branch ${wt.branch} survives with its commits.`;
    } catch (err) {
      return `Couldn't remove ${worktreeId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/**
 * Guard shared by publish/pull: a merge mutates files in the checkout, so it must not run under a
 * live engine turn. Only 'running' blocks — 'idle'/'failed' sessions hold context but execute
 * nothing. (TOCTOU window: a reply could start a turn between this check and the merge — same
 * accepted v0 exposure as remove_worktree's open-session check.)
 */
async function midTurnRefusal(
  sessions: SessionRegistry,
  worktreeId: string,
  verb: string,
): Promise<string | undefined> {
  const running = (await sessions.list({ worktreeId })).filter(
    (s) => s.status === 'running',
  );
  return running.length
    ? `Can't ${verb} while a session is mid-turn in ${worktreeId} (${running
        .map((s) => s.id)
        .join(
          ', ',
        )}) — a merge would mutate files under it. Wait for the report or close it.`
    : undefined;
}

const conflictReply = (
  worktreeId: string,
  verb: string,
  res: { sharedBranch: string; files?: string[] },
): string =>
  `Merge conflict with ${res.sharedBranch} in: ${(res.files ?? []).join(', ') || '(unknown files)'}. The merge is left IN PROGRESS in ${worktreeId} — reply into a session there (mode 'execute') to resolve and commit it, then ${verb} again.`;

const publishWorktreeSchema = z.object({
  worktreeId: z
    .string()
    .describe('The worktree whose committed work to publish.'),
});

@HarnessTool()
export class PublishWorktreeTool implements IHarnessTool<
  typeof publishWorktreeSchema
> {
  readonly name = 'publish_worktree';
  readonly description =
    "Publish a worktree's COMMITTED work onto its shared integration branch so teammates and Dennis can take it. Fast-forwards when possible, otherwise merges teammates' work in first; when the project has a registered GitHub repo the shared branch is pushed to GitHub too (the result says whether that happened). Only commits publish — have a session commit first. Refused while a session in the worktree is mid-turn.";
  readonly schema = publishWorktreeSchema;

  constructor(
    private readonly worktrees: WorktreeService,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  async execute({
    worktreeId,
  }: z.infer<typeof publishWorktreeSchema>): Promise<string> {
    const wt = this.worktrees.get(worktreeId);
    if (!wt) return `No worktree "${worktreeId}".`;
    const refusal = await midTurnRefusal(this.sessions, worktreeId, 'publish');
    if (refusal) return refusal;
    try {
      const res = await this.worktrees.publish(worktreeId);
      if (!res.integrated) return conflictReply(worktreeId, 'publish', res);
      const dirtyNote = res.dirty
        ? ' Note: the worktree has uncommitted changes — those were NOT published (only commits publish).'
        : '';
      // The remote outcome is always stated — a publish that didn't reach GitHub must never read
      // as done (that's how Dennis ends up reviewing a stale PR).
      const remoteNote = res.remote?.pushed
        ? ` Pushed to GitHub — the PR (if open) is up to date.`
        : ` NOT on GitHub: ${res.remote?.detail ?? 'origin sync did not run'}.`;
      return `Published ${wt.branch} → ${res.sharedBranch}.${remoteNote}${dirtyNote}`;
    } catch (err) {
      return `Couldn't publish ${worktreeId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

const pullWorktreeSchema = z.object({
  worktreeId: z
    .string()
    .describe('The worktree to merge the shared branch into.'),
});

@HarnessTool()
export class PullWorktreeTool implements IHarnessTool<
  typeof pullWorktreeSchema
> {
  readonly name = 'pull_worktree';
  readonly description =
    "Merge the shared integration branch into a worktree — take teammates' published work. Refused while a session in the worktree is mid-turn.";
  readonly schema = pullWorktreeSchema;

  constructor(
    private readonly worktrees: WorktreeService,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  async execute({
    worktreeId,
  }: z.infer<typeof pullWorktreeSchema>): Promise<string> {
    const wt = this.worktrees.get(worktreeId);
    if (!wt) return `No worktree "${worktreeId}".`;
    const refusal = await midTurnRefusal(this.sessions, worktreeId, 'pull');
    if (refusal) return refusal;
    try {
      const res = await this.worktrees.pull(worktreeId);
      if (!res.integrated) return conflictReply(worktreeId, 'pull', res);
      return `Pulled ${res.sharedBranch} into ${wt.branch}.${res.originFetched ? ' (Shared branch synced from GitHub first.)' : ' (Local shared branch only — origin was not synced.)'}`;
    } catch (err) {
      return `Couldn't pull into ${worktreeId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
