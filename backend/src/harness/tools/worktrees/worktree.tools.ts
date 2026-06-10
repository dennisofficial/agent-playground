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
});

@HarnessTool()
export class CreateWorktreeTool
  implements IHarnessTool<typeof createWorktreeSchema>
{
  readonly name = 'create_worktree';
  readonly description =
    'Create an isolated git worktree off the project repo — the work area your sessions run in. Cuts a fresh branch from the base by default. Returns the worktree id to open sessions against. Note: a fresh checkout has no installed dependencies; a session can run installs itself if it needs them.';
  readonly schema = createWorktreeSchema;

  constructor(private readonly worktrees: WorktreeService) {}

  async execute(
    { name, branch }: z.infer<typeof createWorktreeSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    try {
      const { worktree, warning } = await this.worktrees.create({
        name,
        branch,
        ownerBot: id.selfAgent,
        project: id.project,
      });
      return `Created ${worktree.id} on branch ${worktree.branch}.${warning ? ` ${warning}` : ''}`;
    } catch (err) {
      return `Couldn't create the worktree: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

const listWorktreesSchema = z.object({});

@HarnessTool()
export class ListWorktreesTool
  implements IHarnessTool<typeof listWorktreesSchema>
{
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
        return `- ${w.id} "${w.name}" — branch ${w.branch}${w.ownerBot ? `, created by ${w.ownerBot}` : ''}; open sessions: ${sessions}`;
      }),
    );
    return lines.join('\n');
  }
}

const removeWorktreeSchema = z.object({
  worktreeId: z.string().describe('The worktree id to remove.'),
});

@HarnessTool()
export class RemoveWorktreeTool
  implements IHarnessTool<typeof removeWorktreeSchema>
{
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
