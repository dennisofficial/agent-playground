import { z } from 'zod';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { recallProjects } from '../../domain/identity';
import { BoardStore, type BoardTask } from '../../memory/board-store';
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

const fmtTask = (t: BoardTask, blockers?: number[]): string =>
  `- [#${t.id}] ${t.title} (${fmtAssignee(t)}, ${t.status})` +
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
    .enum(['open', 'in_progress', 'awaiting_approval', 'approved', 'done'])
    .optional()
    .describe(
      "New status. 'done' completes it; 'open' releases it back to the board (clears the assignee); 'awaiting_approval' posts your finished plan for Dennis's sign-off; 'approved' is TEAM LEAD ONLY, recorded only on Dennis's explicit approval.",
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
    "Update a TEAM BOARD task: complete it ('done'), release it back to the board ('open'), post your finished plan for sign-off ('awaiting_approval'), or — team lead only — reassign/reopen/edit anything and record Dennis's approval ('approved'). Teammates can only complete, release, or post-for-approval their OWN tasks.";
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

    // The approval seam: 'approved' is the record of DENNIS's decision, clerked by the lead.
    if (status === 'approved') {
      if (!isLead)
        return `Marking a plan 'approved' is the team lead's call — and the lead records it only on Dennis's explicit approval. Post yours as 'awaiting_approval' and flag it for the next planning sitting.`;
      if (task.status !== 'awaiting_approval')
        return `Board task #${taskId} is '${task.status}', not 'awaiting_approval' — only a posted plan can be approved. Have the assignee post the plan first.`;
    }

    if (!isLead) {
      if (
        assignee !== undefined ||
        title !== undefined ||
        description !== undefined
      )
        return `Reassigning or editing board tasks is the team lead's call — you can complete ('done'), release ('open'), or post for approval ('awaiting_approval') your own.`;
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
    .enum(['open', 'in_progress', 'awaiting_approval', 'approved', 'done'])
    .optional()
    .describe(
      "Filter by status; omit for everything not done (the live board). 'awaiting_approval' lists the plans queued for Dennis's sign-off.",
    ),
});

@HarnessTool()
export class ListBoardTool implements IHarnessTool<typeof listSchema> {
  readonly name = 'list_board';
  readonly description =
    "The TEAM BOARD — the shared task list with assignees, status, and dependencies (NOT your private reminders; that's list_tasks). Check it before picking up work or when coordinating who does what.";
  readonly schema = listSchema;

  constructor(private readonly board: BoardStore) {}

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
    const lines = tasks.map(
      (t) =>
        `${fmtTask(t, blocked.get(t.id))}${target ? '' : ` [${t.project}]`}`,
    );
    return `Team board${target ? ` (${target})` : ''}:\n${lines.join('\n')}`;
  }
}
