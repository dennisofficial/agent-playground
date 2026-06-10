import { z } from 'zod';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { TaskStore, type Task } from '../../memory/task-store';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * Personal reminders (the "plate"). Per-employee reminders so a commitment in passing isn't
 * forgotten in a long session. The reconcile pass captures these automatically; these tools let a
 * bot read its plate and close things out. A teammate sees only their own plate; the SCRUM MASTER
 * sees everyone's (gated here, not in the table). (Ported from playground/src/memory/tools.ts.)
 */

const fmtTask = (t: Task): string => `- [#${t.id}] ${t.description} (→ ${t.owner})`;

const listSchema = z.object({
  scope: z
    .enum(['mine', 'team'])
    .optional()
    .describe(
      "'mine' (default) for your own plate; 'team' for everyone's — scrum master only, ignored for everyone else.",
    ),
});

@HarnessTool()
export class ListTasksTool implements IHarnessTool<typeof listSchema> {
  readonly name = 'list_tasks';
  readonly description =
    "Your open reminders — the things you committed to do but haven't yet. Use it when picking up work or when someone asks what's on your plate. (Scrum master only: 'team' to see everyone's plates.)";
  readonly schema = listSchema;

  constructor(
    private readonly tasks: TaskStore,
    private readonly employees: EmployeeRegistry,
  ) {}

  async execute({ scope }: z.infer<typeof listSchema>, ctx: HarnessToolContext): Promise<string> {
    const id = ctx.identity;
    const isScrumMaster = !!this.employees.byId(id.selfAgent)?.scrumMaster;
    // 'team' (all plates) is scrum-master only; everyone else always sees just their own plate.
    const owner = scope === 'team' && isScrumMaster ? undefined : id.selfAgent;
    const tasks = await this.tasks.listTasks({ project: id.project, status: 'open', owner });
    if (tasks.length === 0) return owner ? 'Nothing open on your plate.' : 'No open reminders across the team.';
    return `${owner ? 'On your plate' : "Everyone's plates"}:\n${tasks.map(fmtTask).join('\n')}`;
  }
}

const addSchema = z.object({
  description: z.string().describe('The reminder, stated plainly, e.g. "Wire funnel events into the API".'),
  owner: z
    .string()
    .optional()
    .describe("Whose plate it goes on (a teammate's id like 'alex'); omit for your own."),
});

@HarnessTool()
export class AddTaskTool implements IHarnessTool<typeof addSchema> {
  readonly name = 'add_task';
  readonly description =
    "Log a reminder explicitly — a concrete thing to do later. Defaults to your own plate; pass a teammate's id to hand it to them. Most reminders get captured automatically; use this to be sure one is tracked.";
  readonly schema = addSchema;

  constructor(private readonly tasks: TaskStore) {}

  async execute({ description, owner }: z.infer<typeof addSchema>, ctx: HarnessToolContext): Promise<string> {
    const id = ctx.identity;
    const onPlate = owner?.trim().toLowerCase() || id.selfAgent; // default: your own plate
    const t = await this.tasks.addTask({
      project: id.project,
      description,
      owner: onPlate,
      createdBy: id.selfAgent,
    });
    if (!t) return "That's already on the plate — left it as is.";
    return onPlate === id.selfAgent ? `Added reminder #${t.id}.` : `Added reminder #${t.id} for ${onPlate}.`;
  }
}

const completeSchema = z.object({
  id: z.number().describe('The reminder id to complete (the #N from list_tasks).'),
});

@HarnessTool()
export class CompleteTaskTool implements IHarnessTool<typeof completeSchema> {
  readonly name = 'complete_task';
  readonly description =
    "Mark a reminder done once it's actually finished — pass the reminder id (the #N from list_tasks). Normally one of your own; as scrum master you can also clear a stale or misassigned reminder off any teammate's plate.";
  readonly schema = completeSchema;

  constructor(
    private readonly tasks: TaskStore,
    private readonly employees: EmployeeRegistry,
  ) {}

  async execute({ id: taskId }: z.infer<typeof completeSchema>, ctx: HarnessToolContext): Promise<string> {
    const id = ctx.identity;
    const task = await this.tasks.getTask(id.project, taskId);
    if (!task || task.status !== 'open') return `No open reminder #${taskId} found.`;
    // Authority: only the plate's owner, or the scrum master, may close it.
    if (task.owner !== id.selfAgent && !this.employees.byId(id.selfAgent)?.scrumMaster) {
      return `Reminder #${taskId} is on ${task.owner}'s plate — only they or the scrum master can close it.`;
    }
    await this.tasks.completeTask(id.project, taskId);
    return task.owner === id.selfAgent
      ? `Marked reminder #${taskId} done.`
      : `Cleared reminder #${taskId} off ${task.owner}'s plate.`;
  }
}
