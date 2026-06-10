import { z } from 'zod';
import { WorklogStore } from '../../memory/worklog-store';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

const recentWorkSchema = z.object({
  scope: z
    .enum(['mine', 'team'])
    .optional()
    .describe(
      "'mine' (default) for your own completed work, 'team' for everyone's.",
    ),
});

@HarnessTool()
export class RecentWorkTool implements IHarnessTool<typeof recentWorkSchema> {
  readonly name = 'recent_work';
  readonly description =
    "Your (or the team's) recently completed background work, newest first — logged when a session closes with a report. Use this for standups or whenever someone asks what you've been working on; it's how you remember what you actually did.";
  readonly schema = recentWorkSchema;

  constructor(private readonly worklog: WorklogStore) {}

  async execute(
    { scope }: z.infer<typeof recentWorkSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const entries = await this.worklog.recentWork({
      project: id.project,
      ownerBot: scope === 'team' ? undefined : id.selfAgent,
      limit: 10,
    });
    if (entries.length === 0) {
      return scope === 'team'
        ? 'No completed work is logged for the team yet.'
        : 'I have no completed work logged yet — nothing finished in a previous session.';
    }
    return entries
      .map(
        (e) =>
          `- [${e.completedAt.slice(0, 10)}] ${e.ownerBot}: ${e.task} — ${e.summary.slice(0, 160)}`,
      )
      .join('\n');
  }
}
