import { z } from 'zod';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { recallProjects } from '../../domain/identity';
import { BoardStore, type BoardTask } from '../../memory/board-store';
import { PlanStore, type PlanState } from '../../memory/plan-store';
import { STATUS_COLUMN_GUIDE } from '../../employees/persona.prompts';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * The TEAM BOARD — the shared task list the team coordinates multi-step / multi-person work on.
 * Distinct from the personal reminder plate (task.tools.ts): board entries are deliberate work
 * items with an assignee and dependencies, not auto-captured commitments. Authority is gated here
 * (not in the table): the team lead creates/assigns/edits anything; a teammate files unassigned or
 * self-assigned work, claims, and completes their own.
 */

const fmtAssignee = (t: BoardTask): string =>
  t.assignee ? `→ ${t.assignee}` : 'unassigned';

const fmtPlan = (s?: PlanState): string =>
  s && s !== 'none' ? `, plan: ${s}` : '';

const fmtTask = (t: BoardTask, blockers?: number[], plan?: PlanState): string =>
  `- [#${t.id}] ${t.title} (${fmtAssignee(t)}, ${t.status}${fmtPlan(plan)})` +
  (t.dependsOn.length ? ` after #${t.dependsOn.join(', #')}` : '') +
  (blockers?.length ? ` — BLOCKED by #${blockers.join(', #')}` : '');

const addSchema = z.object({
  title: z
    .string()
    .describe('Short imperative work item, e.g. "Wire the auth API contract".'),
  description: z
    .string()
    .optional()
    .describe(
      'Detail / acceptance criteria, if the title alone is not enough.',
    ),
  project: z
    .string()
    .optional()
    .describe(
      "Which project's board it belongs to; omit for the current room's project.",
    ),
  assignee: z
    .string()
    .optional()
    .describe(
      "Who owns it (a teammate's id like 'alex'). Omit to leave it on the board, up for grabs. Assigning to someone ELSE is team-lead only.",
    ),
  depends_on: z
    .array(z.number())
    .optional()
    .describe(
      'Board task ids (the #N) that must be done before this one can be claimed.',
    ),
});

@HarnessTool()
export class AddBoardTaskTool implements IHarnessTool<typeof addSchema> {
  readonly name = 'add_board_task';
  readonly description =
    'Put a work item on the TEAM BOARD — the shared task list (NOT your private reminders). Use it for deliberate, claimable units of work, optionally with dependencies. The team lead assigns to anyone; everyone else files items unassigned or for themselves.';
  readonly schema = addSchema;

  constructor(
    private readonly board: BoardStore,
    private readonly employees: EmployeeRegistry,
  ) {}

  async execute(
    {
      title,
      description,
      project,
      assignee,
      depends_on,
    }: z.infer<typeof addSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const owner = assignee?.trim().toLowerCase() || undefined;
    if (owner && !this.employees.byId(owner))
      return `No teammate '${owner}' on the roster — leave it unassigned or use a roster id.`;
    // Cross-assignment is the lead's call — mirrors the personal-plate cross-owner rule.
    if (
      owner &&
      owner !== id.selfAgent &&
      !this.employees.byId(id.selfAgent)?.teamLead
    ) {
      return `Only the team lead assigns board tasks to someone else — file it unassigned (or for yourself) and flag it to the lead.`;
    }
    const named = project?.trim().toLowerCase();
    const target =
      named && recallProjects(id).includes(named) ? named : id.project;
    const created = await this.board.create({
      team: id.team,
      project: target,
      title,
      description,
      assignee: owner,
      createdBy: id.selfAgent,
      dependsOn: depends_on,
    });
    if ('unknownDeps' in created)
      return `Unknown dependency id(s) #${created.unknownDeps.join(', #')} — check list_board and retry.`;
    const deps = created.dependsOn.length
      ? `, after #${created.dependsOn.join(', #')}`
      : '';
    return `Added board task #${created.id} (${fmtAssignee(created)}${deps}) [${target}].`;
  }
}

const claimSchema = z.object({
  id: z
    .number()
    .describe('The board task id to claim (the #N from list_board).'),
});

@HarnessTool()
export class ClaimBoardTaskTool implements IHarnessTool<typeof claimSchema> {
  readonly name = 'claim_board_task';
  readonly description =
    "Claim a TEAM BOARD task and start it — atomically, so two teammates can't grab the same one. Works on unassigned open tasks, or one already assigned to you; refused while a dependency is unfinished.";
  readonly schema = claimSchema;

  constructor(private readonly board: BoardStore) {}

  async execute(
    { id: taskId }: z.infer<typeof claimSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const result = await this.board.claim(id.team, taskId, id.selfAgent);
    if (typeof result !== 'string')
      return `Claimed board task #${result.id} — it's yours, in progress: ${result.title}`;
    if (result === 'missing') return `No board task #${taskId} found.`;
    if (result === 'taken') {
      const t = await this.board.get(id.team, taskId);
      return t && t.status !== 'open'
        ? `Board task #${taskId} is already ${t.status}${t.assignee ? ` (${t.assignee})` : ''}.`
        : `Board task #${taskId} is assigned to ${t?.assignee} — not yours to claim.`;
    }
    const t = await this.board.get(id.team, taskId);
    const blockers = t
      ? (await this.board.blockersOf(id.team, [t])).get(t.id)
      : undefined;
    return `Board task #${taskId} is blocked${blockers?.length ? ` by #${blockers.join(', #')}` : ' by unfinished dependencies'} — finish those first.`;
  }
}

const updateSchema = z.object({
  id: z.number().describe('The board task id (the #N from list_board).'),
  status: z
    .enum([
      'open',
      'in_progress',
      'awaiting_approval',
      'approved',
      'in_review',
      'done',
    ])
    .optional()
    .describe(
      "New status. 'open' releases it back to the board (clears the assignee). 'awaiting_approval' and 'approved' are TEAM LEAD ONLY (proposing normally happens via propose_plan; 'approved' records Dennis's verdict). 'in_review' is normally set by mark_pr_ready when the PR is up. 'done' completes it — but for APPROVED work that's the team lead recording Dennis's acceptance, not the assignee.",
    ),
  assignee: z
    .string()
    .optional()
    .describe("Reassign to a teammate's id (team lead only)."),
  title: z.string().optional().describe('Rewrite the title (team lead only).'),
  description: z
    .string()
    .optional()
    .describe('Rewrite the description (team lead only).'),
});

@HarnessTool()
export class UpdateBoardTaskTool implements IHarnessTool<typeof updateSchema> {
  readonly name = 'update_board_task';
  readonly description =
    "Update a TEAM BOARD task: complete it ('done'), release it back to the board ('open'), or — team lead only — reassign/reopen/edit anything, propose manually ('awaiting_approval'; normally propose_plan does this), and record Dennis's approval ('approved'). Teammates can only complete or release their OWN tasks.";
  readonly schema = updateSchema;

  constructor(
    private readonly board: BoardStore,
    private readonly employees: EmployeeRegistry,
  ) {}

  async execute(
    {
      id: taskId,
      status,
      assignee,
      title,
      description,
    }: z.infer<typeof updateSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const task = await this.board.get(id.team, taskId);
    if (!task) return `No board task #${taskId} found.`;
    const isLead = !!this.employees.byId(id.selfAgent)?.teamLead;
    const release = status === 'open';

    // The approval seam: 'approved' is the record of DENNIS's decision, clerked by the lead, and
    // 'awaiting_approval' is set by the lead's propose_plan (manual set = the lead's escape hatch).
    if (status === 'approved') {
      if (!isLead)
        return `Marking a plan 'approved' is the team lead's call — and the lead records it only on Dennis's explicit approval.`;
      if (task.status !== 'awaiting_approval')
        return `Board task #${taskId} is '${task.status}', not 'awaiting_approval' — only a proposed ticket can be approved (propose_plan proposes it).`;
    }
    if (status === 'awaiting_approval' && !isLead)
      return `Posting for approval isn't a status you set — your plan AUTO-ATTACHES to the ticket when your linked planning session finishes. Notify @Sam your plan on #${taskId} is ready for review; he proposes the ticket to Dennis (propose_plan) once every plan is lead-approved.`;
    // Completing APPROVED work is Dennis's acceptance, clerked by the lead — an assignee can't
    // self-'done' a ticket that went through approval (or is in review). They keep iterating on
    // review feedback in their execute session; the lead marks it done once Dennis accepts the PR.
    if (
      status === 'done' &&
      (task.status === 'approved' || task.status === 'in_review') &&
      !isLead
    )
      return `Board task #${taskId} is '${task.status}' — completing approved work records Dennis's acceptance, which is the team lead's call. Keep addressing review feedback in your execute session; @Sam marks it 'done' once Dennis accepts the PR.`;

    if (!isLead) {
      if (
        assignee !== undefined ||
        title !== undefined ||
        description !== undefined
      )
        return `Reassigning or editing board tasks is the team lead's call — you can complete ('done') or release ('open') your own.`;
      if (task.assignee !== id.selfAgent)
        return `Board task #${taskId} is ${task.assignee ? `${task.assignee}'s` : 'unassigned'} — only they or the team lead can change it.`;
      if (!status) return `Nothing to change on #${taskId}.`;
      if (status === 'in_progress')
        return `Use claim_board_task to start a task — it checks dependencies atomically.`;
    }
    const newAssignee = assignee?.trim().toLowerCase();
    if (newAssignee && !this.employees.byId(newAssignee))
      return `No teammate '${newAssignee}' on the roster.`;

    const updated = await this.board.update(id.team, taskId, {
      ...(status !== undefined ? { status } : {}),
      // Releasing puts it back up for grabs; a lead reassignment overrides.
      ...(newAssignee !== undefined
        ? { assignee: newAssignee }
        : release
          ? { assignee: null }
          : {}),
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
    });
    if (!updated) return `No board task #${taskId} found.`;
    if (status === 'done')
      return `Board task #${taskId} done: ${updated.title}`;
    if (status === 'awaiting_approval')
      return `Board task #${taskId} posted for approval: ${updated.title} — it queues for Dennis's next planning sitting.`;
    if (status === 'approved')
      return `Board task #${taskId} APPROVED: ${updated.title} — ${updated.assignee ?? 'the assignee'} can flip its session to execute.`;
    if (release && !newAssignee)
      return `Board task #${taskId} released back to the board (unassigned, open).`;
    return `Updated board task #${taskId} (${fmtAssignee(updated)}, ${updated.status}).`;
  }
}

const listSchema = z.object({
  project: z
    .string()
    .optional()
    .describe(
      "Which project's board; omit for the current room's project, or 'all' for every project.",
    ),
  assignee: z
    .string()
    .optional()
    .describe("Filter to one teammate's tasks (a roster id like 'alex')."),
  status: z
    .enum([
      'open',
      'in_progress',
      'awaiting_approval',
      'approved',
      'in_review',
      'done',
    ])
    .optional()
    .describe(
      "Filter by status; omit for everything not done (the live board). 'awaiting_approval' lists the plans queued for Dennis's sign-off; 'in_review' lists the PRs up and waiting on him.",
    ),
});

@HarnessTool()
export class ListBoardTool implements IHarnessTool<typeof listSchema> {
  readonly name = 'list_board';
  readonly description =
    "The TEAM BOARD — the shared task list with assignees, status, and dependencies (NOT your private reminders; that's list_tasks). Check it before picking up work or when coordinating who does what.\n\n" +
    STATUS_COLUMN_GUIDE;
  readonly schema = listSchema;

  constructor(
    private readonly board: BoardStore,
    private readonly plans: PlanStore,
  ) {}

  async execute(
    { project, assignee, status }: z.infer<typeof listSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const named = project?.trim().toLowerCase();
    const target = named === 'all' ? undefined : named || id.project;
    const tasks = (
      await this.board.list({
        team: id.team,
        project: target,
        assignee: assignee?.trim().toLowerCase() || undefined,
        status,
      })
    ).filter((t) => status || t.status !== 'done'); // default view: the live board
    if (tasks.length === 0)
      return target ? `The ${target} board is clear.` : 'The board is clear.';
    const blocked = await this.board.blockersOf(id.team, tasks);
    const planStates = await this.plans.planStatesOf(
      id.team,
      tasks.map((t) => t.id),
    );
    const lines = tasks.map(
      (t) =>
        `${fmtTask(t, blocked.get(t.id), planStates.get(t.id))}${target ? '' : ` [${t.project}]`}`,
    );
    return `Team board${target ? ` (${target})` : ''}:\n${lines.join('\n')}`;
  }
}
