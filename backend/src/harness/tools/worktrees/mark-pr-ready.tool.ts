import { z } from 'zod';
import { BoardStore } from '../../memory/board-store';
import { TicketNoteStore } from '../../memory/ticket-note-store';
import { parseGithubRepo } from '../../projects/git-auth';
import { GithubApiService } from '../../projects/github-api.service';
import { GithubTokenStore } from '../../projects/github-token-store';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { WorktreeService } from '../../worktrees/worktree.service';
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
 * board task to 'in_review'. The two truths agree — the PR is no longer a draft, and the board lists
 * the ticket as awaiting Dennis. Review feedback is then addressed in the SAME execute session with
 * no re-approval; the lead marks the ticket 'done' once Dennis accepts.
 */
@HarnessTool()
export class MarkPrReadyTool implements IHarnessTool<typeof markReadySchema> {
  readonly name = 'mark_pr_ready';
  readonly description =
    "Flip your DRAFT PR to ready-for-review and move its board task to 'in_review' — call it when the work is done and you want Dennis to review. Until then leave the PR a draft. Open the PR first with open_pr.";
  readonly schema = markReadySchema;

  constructor(
    private readonly worktrees: WorktreeService,
    private readonly tokens: GithubTokenStore,
    private readonly github: GithubApiService,
    private readonly board: BoardStore,
    private readonly notes: TicketNoteStore,
    private readonly employees: EmployeeRegistry,
  ) {}

  async execute(
    { worktreeId, board_task_id }: z.infer<typeof markReadySchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const task = await this.board.get(id.team, board_task_id);
    if (!task) return `No board task #${board_task_id} found.`;
    // Only the owner (or the lead) marks the work ready — and only APPROVED work has a PR to ready.
    const isLead = !!this.employees.byId(id.selfAgent)?.teamLead;
    if (task.assignee !== id.selfAgent && !isLead)
      return `Board task #${board_task_id} is ${task.assignee ? `${task.assignee}'s` : 'unassigned'} — only they or the team lead mark its PR ready.`;
    // Lead-only override now that the review pipeline normally readies PRs automatically — accept any
    // execution-phase status (the work has a shared-branch PR to ready).
    const readyable = ['approved', 'executing', 'self_review', 'in_review'];
    if (!readyable.includes(task.status))
      return `Board task #${board_task_id} is '${task.status}', not in execution — only approved/executing work has a PR to mark ready.`;

    const wt = this.worktrees.get(worktreeId);
    if (!wt) return `No worktree "${worktreeId}".`;
    if (!wt.sharedBranch)
      return `${worktreeId} isn't on a shared branch — the PR is opened from the shared branch (open_pr).`;
    const rec = await this.worktrees.projectRecordFor(worktreeId);
    if (!rec)
      return `No registered GitHub repo matches ${worktreeId} (project "${wt.project || '(none)'}").`;
    const auth = await this.tokens
      .resolve(rec.teamId, rec.tokenName)
      .catch(() => undefined);
    if (!auth)
      return rec.tokenName
        ? `The project's GitHub token "${rec.tokenName}" isn't in the token store.`
        : 'No default GitHub token is stored.';

    const { owner, repo } = parseGithubRepo(rec.gitUrl);
    const open = await this.github
      .listOpenPullRequests(auth.token, { owner, repo })
      .catch(() => []);
    const pr = open.find((p) => p.headBranch === wt.sharedBranch);
    if (!pr)
      return `No open PR found for ${wt.sharedBranch} — open it first with open_pr.`;

    try {
      await this.github.markReadyForReview(auth.token, {
        owner,
        repo,
        number: pr.number,
      });
    } catch (err) {
      return `Couldn't mark PR #${pr.number} ready: ${err instanceof Error ? err.message : String(err)}`;
    }

    // The board signal — flip to in_review (a no-op if already there). Note the PR on the ticket so
    // the link is durable (the ticket outlives the session).
    if (task.status !== 'in_review')
      await this.board.update(id.team, board_task_id, { status: 'in_review' });
    await this.notes
      .add(
        id.team,
        board_task_id,
        id.selfAgent,
        `PR ready for review: ${pr.url}`,
      )
      .catch(() => undefined);

    return `PR #${pr.number} marked ready for review: ${pr.url}. Board task #${board_task_id} → in_review — it's Dennis's to review now. Address any feedback in this same execute session (no re-approval); @Sam marks it done once Dennis accepts.`;
  }
}
