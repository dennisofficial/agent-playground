import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { recallProjects } from '../../domain/identity';
import { BoardStore } from '../../memory/board-store';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { PipelineRunnerService } from '../../sessions/pipeline-runner.service';
import { WorktreeService } from '../../worktrees/worktree.service';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * The orchestrator's pipeline tools. `dispatch_pipeline` runs an approved board task as a dynamic
 * section-driven run (you declare the sections; each is planned just-in-time and built phase-by-phase)
 * or a single-session bugfix; `enqueue_finding` parks an out-of-scope discovery on the backlog for
 * later human triage (never auto-approved).
 */

const sectionSchema = z.object({
  name: z.string().describe('Section name, e.g. "backend" or "frontend".'),
  brief: z
    .string()
    .optional()
    .describe("One-line intent for this section (seeds its plan)."),
  role: z
    .string()
    .describe(
      "The phase-config to build this section as, e.g. 'phase_backend'. Scopes its skills/engines.",
    ),
});

const dispatchSchema = z.object({
  board_task_id: z
    .number()
    .int()
    .describe('The approved team-board task (#N) to run.'),
  worktree_id: z
    .string()
    .describe('The worktree the run happens in (create_worktree first).'),
  kind: z
    .enum(['feature', 'bugfix'])
    .optional()
    .describe(
      "'feature' (default): the declared sections plan→gate→build→PR in order. 'bugfix': a single execute session straight to a PR (no plan gate).",
    ),
  sections: z
    .array(sectionSchema)
    .optional()
    .describe(
      'For a feature: the ordered sections to build (each planned just-in-time, after the prior ships). Required for kind=feature.',
    ),
  role: z
    .string()
    .optional()
    .describe(
      "For a bugfix: the phase-config to run the single fix session as. Required for kind=bugfix.",
    ),
});

@HarnessTool()
export class DispatchPipelineTool implements IHarnessTool<typeof dispatchSchema> {
  readonly name = 'dispatch_pipeline';
  readonly description =
    'Dispatch an approved board task. A feature runs your declared sections in order — each planned just-in-time (and gated for your approval) then built phase-by-phase with a fresh review after each, all in one worktree, shipping one PR. A bugfix runs a single execute session straight to a PR. It advances automatically; you are notified at each gate.';
  readonly schema = dispatchSchema;
  private readonly logger = new Logger(DispatchPipelineTool.name);

  constructor(
    private readonly board: BoardStore,
    private readonly worktrees: WorktreeService,
    private readonly employees: EmployeeRegistry,
    private readonly runner: PipelineRunnerService,
  ) {}

  async execute(
    { board_task_id, worktree_id, kind, sections, role }: z.infer<
      typeof dispatchSchema
    >,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const runKind = kind ?? 'feature';
    const task = await this.board.get(id.team, board_task_id);
    if (!task) return `No board task #${board_task_id} — check list_board.`;
    const worktree = this.worktrees.get(worktree_id);
    if (!worktree)
      return `No worktree '${worktree_id}' — create one first (create_worktree).`;

    // Validate the phase-config role(s) resolve before starting (a typo'd role would otherwise fail
    // the run mid-flight).
    const roles =
      runKind === 'bugfix' ? (role ? [role] : []) : (sections ?? []).map((s) => s.role);
    if (runKind === 'feature' && (!sections || sections.length === 0))
      return `A feature run needs at least one section (name + role). Declare the sections and re-dispatch.`;
    if (runKind === 'bugfix' && !role)
      return `A bugfix run needs a role — the phase-config to fix as (e.g. 'phase_backend').`;
    for (const r of roles)
      if (!this.employees.byId(r))
        return `Unknown phase-config '${r}'. Use a real one (e.g. 'phase_backend').`;

    // Start AWAITED so a startup failure reaches the orchestrator as the tool result, not a swallowed
    // log. start() does all durable setup (run row + section rows) and opens the first session; only
    // the engine TURN is detached (inside openStageSession). The ALS reset keeps that setup out of the
    // orchestrator's chat-stream trace/cost footer.
    try {
      await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
        this.runner.start({
          team: id.team,
          project: task.project,
          taskId: board_task_id,
          worktreeId: worktree_id,
          notifyThread: id.surface,
          kind: runKind,
          sections:
            runKind === 'feature'
              ? sections!.map((s) => ({
                  name: s.name,
                  brief: s.brief,
                  role: s.role,
                }))
              : undefined,
          role: runKind === 'bugfix' ? role : undefined,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `dispatch_pipeline: starting ${runKind} for #${board_task_id} in ${worktree_id} failed: ${err}`,
      );
      const detail = err instanceof Error ? err.message : String(err);
      return `Couldn't start the ${runKind} run for #${board_task_id} in ${worktree_id}: ${detail}. Nothing is running — no run was created and the task is unchanged. Do NOT report this as dispatched; fix the cause and retry.`;
    }
    return runKind === 'bugfix'
      ? `Dispatched a bugfix session for #${board_task_id} in ${worktree_id}. It runs straight to a PR — I'll surface it at the PR gate.`
      : `Dispatched the ${sections!.length}-section pipeline for #${board_task_id} in ${worktree_id}. It's planning the first section now and will pause at its plan gate for your review.`;
  }
}

const enqueueSchema = z.object({
  title: z
    .string()
    .describe('Short imperative title of the out-of-scope finding.'),
  description: z
    .string()
    .optional()
    .describe('Detail / why it matters, if the title alone is not enough.'),
  project: z
    .string()
    .optional()
    .describe(
      "Which project's backlog; omit for the current room's project.",
    ),
});

@HarnessTool()
export class EnqueueFindingTool implements IHarnessTool<typeof enqueueSchema> {
  readonly name = 'enqueue_finding';
  readonly description =
    "Park an out-of-scope finding on the backlog for later triage — it lands as an unassigned, un-approved item the orchestrator and Dennis prune together. Use it for things you notice mid-work that don't belong in the current task. It is NEVER auto-approved or auto-worked.";
  readonly schema = enqueueSchema;

  constructor(private readonly board: BoardStore) {}

  async execute(
    { title, description, project }: z.infer<typeof enqueueSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const named = project?.trim().toLowerCase();
    const target =
      named && recallProjects(id).includes(named) ? named : id.project;
    const created = await this.board.create({
      team: id.team,
      project: target,
      title,
      description,
      createdBy: id.selfAgent,
    });
    if ('unknownDeps' in created)
      return `Couldn't park the finding — try again.`;
    return `Parked finding #${created.id} on the ${target} backlog for triage: ${title}`;
  }
}
