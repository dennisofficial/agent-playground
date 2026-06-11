import { z } from 'zod';
import { recallProjects } from '../../domain/identity';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { TaskStore, type Task } from '../../memory/task-store';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * Personal reminders (the "plate"). Per-employee reminders so a commitment in passing isn't
 * forgotten in a long session. The reconcile pass captures these automatically; these tools let a
 * bot read its plate and close things out. A teammate sees only their own plate; the TEAM LEAD
 * sees everyone's (gated here, not in the table). (Ported from playground/src/memory/tools.ts.)
 */

const fmtTask = (t: Task): string =>
  `- [#${t.id}] ${t.description} (→ ${t.owner})`;

const listSchema = z.object({
  scope: z
    .enum(['mine', 'team'])
    .optional()
    .describe(
      "'mine' (default) for your own plate; 'team' for everyone's — team lead only, ignored for everyone else.",
    ),
});

@HarnessTool()
export class ListTasksTool implements IHarnessTool<typeof listSchema> {
  readonly name = 'list_tasks';
  readonly description =
    "Your open reminders — the things you committed to do but haven't yet. Use it when picking up work or when someone asks what's on your plate. (Team lead only: 'team' to see everyone's plates.)";
  readonly schema = listSchema;

  constructor(
    private readonly tasks: TaskStore,
    private readonly employees: EmployeeRegistry,
  ) {}

  async execute(
    { scope }: z.infer<typeof listSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const isTeamLead = !!this.employees.byId(id.selfAgent)?.teamLead;
    // 'team' (all plates) is team-lead only; everyone else always sees just their own plate.
    const owner = scope === 'team' && isTeamLead ? undefined : id.selfAgent;
    // The plate spans every recallable project (one in a channel; the shared set in a DM).
    const projects = recallProjects(id);
    const tasks = (
      await Promise.all(
        projects.map((project) =>
          this.tasks.listTasks({
            team: id.team,
            project,
            status: 'open',
            owner,
          }),
        ),
      )
    ).flat();
    if (tasks.length === 0)
      return owner
        ? 'Nothing open on your plate.'
        : 'No open reminders across the team.';
    const fmt = (t: Task) =>
      `${fmtTask(t)}${projects.length > 1 ? ` [${t.project}]` : ''}`;
    return `${owner ? 'On your plate' : "Everyone's plates"}:\n${tasks.map(fmt).join('\n')}`;
  }
}

const addSchema = z.object({
  description: z
    .string()
    .describe(
      'The reminder, stated plainly, e.g. "Wire funnel events into the API".',
    ),
  owner: z
    .string()
    .optional()
    .describe(
      "Whose plate it goes on (a teammate's id like 'alex'); omit for your own.",
    ),
  project: z
    .string()
    .optional()
    .describe(
      'ONLY in a DM: which project the reminder belongs to (a DM is not bound to one). Must be a project you share with this person; omit for a general reminder.',
    ),
});

@HarnessTool()
export class AddTaskTool implements IHarnessTool<typeof addSchema> {
  readonly name = 'add_task';
  readonly description =
    "Log a reminder explicitly — a concrete thing to do later. Defaults to your own plate; pass a teammate's id to hand it to them. Most reminders get captured automatically; use this to be sure one is tracked.";
  readonly schema = addSchema;

  constructor(private readonly tasks: TaskStore) {}

  async execute(
    { description, owner, project }: z.infer<typeof addSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const onPlate = owner?.trim().toLowerCase() || id.selfAgent; // default: your own plate
    // A named project must be one this conversation may see; else the turn's home project.
    const named = project?.trim().toLowerCase();
    const target =
      named && recallProjects(id).includes(named) ? named : id.project;
    const t = await this.tasks.addTask({
      team: id.team,
      project: target,
      description,
      owner: onPlate,
      createdBy: id.selfAgent,
    });
    if (!t) return "That's already on the plate — left it as is.";
    const suffix = target !== id.project ? ` (${target})` : '';
    return onPlate === id.selfAgent
      ? `Added reminder #${t.id}${suffix}.`
      : `Added reminder #${t.id} for ${onPlate}${suffix}.`;
  }
}

const completeSchema = z.object({
  id: z
    .number()
    .describe('The reminder id to complete (the #N from list_tasks).'),
});

@HarnessTool()
export class CompleteTaskTool implements IHarnessTool<typeof completeSchema> {
  readonly name = 'complete_task';
  readonly description =
    "Mark a reminder done once it's actually finished — pass the reminder id (the #N from list_tasks). Normally one of your own; as team lead you can also clear a stale or misassigned reminder off any teammate's plate.";
  readonly schema = completeSchema;

  constructor(
    private readonly tasks: TaskStore,
    private readonly employees: EmployeeRegistry,
  ) {}

  async execute(
    { id: taskId }: z.infer<typeof completeSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    // Look the id up across every recallable project (a DM's plate spans the shared set).
    let task: Task | undefined;
    for (const project of recallProjects(id)) {
      const t = await this.tasks.getTask(id.team, project, taskId);
      if (t) {
        task = t;
        break;
      }
    }
    if (!task || task.status !== 'open')
      return `No open reminder #${taskId} found.`;
    // Authority: only the plate's owner, or the team lead, may close it.
    if (
      task.owner !== id.selfAgent &&
      !this.employees.byId(id.selfAgent)?.teamLead
    ) {
      return `Reminder #${taskId} is on ${task.owner}'s plate — only they or the team lead can close it.`;
    }
    await this.tasks.completeTask(id.team, task.project, taskId);
    return task.owner === id.selfAgent
      ? `Marked reminder #${taskId} done.`
      : `Cleared reminder #${taskId} off ${task.owner}'s plate.`;
  }
}
