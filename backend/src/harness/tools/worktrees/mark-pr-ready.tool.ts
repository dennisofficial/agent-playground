import { z } from 'zod';
import { BoardStore } from '../../memory/board-store';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { ReviewPipelineService } from '../../sessions/review-pipeline.service';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

const markReadySchema = z.object({
  worktreeId: z
    .string()
    .describe('The worktree whose draft PR is ready for Dennis.'),
  board_task_id: z
    .number()
    .int()
    .describe(
      "The board task (#N) this PR completes — it flips to 'in_review'.",
    ),
});

/**
 * The "it's your turn, Dennis" signal: flip a feature's DRAFT PR to ready-for-review and move its
 * board task to 'in_review'. The owner's ship decision after the harness self-review hands it to them
 * (the pipeline opened the draft PR + reviewed, but no longer flips it to ready itself). The actual
 * ship is delegated to `ReviewPipelineService.shipSharedPr` — the SAME path advisory mode runs — so a
 * shared-feature PR flips EVERY sibling ticket to in_review and narrates readiness to each owner, not
 * just this one. Review feedback is then addressed in the same execute session with no re-approval;
 * the lead marks the ticket 'done' once Dennis accepts.
 */
@HarnessTool()
export class MarkPrReadyTool implements IHarnessTool<typeof markReadySchema> {
  readonly name = 'mark_pr_ready';
  readonly description =
    "Ship your work: flip its DRAFT PR to ready-for-review and move the board task to 'in_review' for Dennis — your call once the self-review hands you the decision (the harness already opened the draft PR). For a shared feature this readies the whole PR once every ticket on it is in. The harness announces the PR is ready, so keep this message's heads-up brief.";
  readonly schema = markReadySchema;

  constructor(
    private readonly board: BoardStore,
    private readonly employees: EmployeeRegistry,
    private readonly reviewPipeline: ReviewPipelineService,
  ) {}

  async execute(
    { board_task_id }: z.infer<typeof markReadySchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const task = await this.board.get(id.team, board_task_id);
    if (!task) return `No board task #${board_task_id} found.`;
    // Only the owner (or the lead) ships — and only execution-phase work has a PR to ready.
    const isLead = !!this.employees.byId(id.selfAgent)?.teamLead;
    if (task.assignee !== id.selfAgent && !isLead)
      return `Board task #${board_task_id} is ${task.assignee ? `${task.assignee}'s` : 'unassigned'} — only they or the team lead mark its PR ready.`;
    const readyable = ['approved', 'executing', 'self_review', 'in_review'];
    if (!readyable.includes(task.status))
      return `Board task #${board_task_id} is '${task.status}', not in execution — only approved/executing work has a PR to mark ready.`;

    // Delegate to the single ship path (markReady + flip every sibling → in_review + fan pr-ready +
    // aggregate the PR metadata). It resolves the repo/PR from the ticket's anchor plan row.
    const res = await this.reviewPipeline.shipSharedPr(id.team, board_task_id);
    if (!res.ok)
      return `Couldn't mark #${board_task_id}'s PR ready: ${res.reason ?? 'unknown error'}.`;

    return `Marked #${board_task_id}'s PR ready for review — it's Dennis's now. The team's notified; address any feedback in this same execute session (no re-approval); @Sam marks it done once Dennis accepts.`;
  }
}
