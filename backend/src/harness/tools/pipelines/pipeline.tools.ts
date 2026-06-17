import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { recallProjects } from '../../domain/identity';
import { BoardStore } from '../../memory/board-store';
import { PipelineRegistry } from '../../pipelines/pipeline.registry';
import { PipelineRunnerService } from '../../sessions/pipeline-runner.service';
import { WorktreeService } from '../../worktrees/worktree.service';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * The orchestrator's pipeline tools. `dispatch_pipeline` runs an approved board task through a
 * declarative pipeline (each stage = a specialist session in one worktree); `enqueue_finding` parks
 * an out-of-scope discovery on the backlog for later human triage (never auto-approved).
 */

const dispatchSchema = z.object({
  board_task_id: z
    .number()
    .int()
    .describe('The approved team-board task (#N) to run a pipeline for.'),
  worktree_id: z
    .string()
    .describe('The worktree the pipeline runs in (create_worktree first).'),
  pipeline: z
    .string()
    .optional()
    .describe("Which pipeline to run; defaults to 'feature'."),
});

@HarnessTool()
export class DispatchPipelineTool implements IHarnessTool<typeof dispatchSchema> {
  readonly name = 'dispatch_pipeline';
  readonly description =
    'Dispatch an approved board task through a deterministic pipeline — each stage runs as a specialist session in the given worktree, advancing automatically and pausing at the plan and PR gates for your review. You are notified as stages report back; no need to babysit it.';
  readonly schema = dispatchSchema;
  private readonly logger = new Logger(DispatchPipelineTool.name);

  constructor(
    private readonly board: BoardStore,
    private readonly worktrees: WorktreeService,
    private readonly pipelines: PipelineRegistry,
    private readonly runner: PipelineRunnerService,
  ) {}

  async execute(
    { board_task_id, worktree_id, pipeline }: z.infer<typeof dispatchSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const name = pipeline?.trim() || 'feature';
    const known = this.pipelines.list().map((d) => d.name);
    if (!known.includes(name))
      return `No pipeline '${name}'. Available: ${known.join(', ')}.`;
    const task = await this.board.get(id.team, board_task_id);
    if (!task) return `No board task #${board_task_id} — check list_board.`;
    const worktree = this.worktrees.get(worktree_id);
    if (!worktree)
      return `No worktree '${worktree_id}' — create one first (create_worktree).`;
    // Detached: the pipeline's stage sessions run their own engine turns; the ALS reset keeps those
    // tokens out of the orchestrator's chat-stream trace/cost footer.
    AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => {
      void this.runner
        .start({
          team: id.team,
          project: task.project,
          taskId: board_task_id,
          pipeline: name,
          worktreeId: worktree_id,
          notifyThread: id.surface,
        })
        .catch((err) =>
          // Detached start: surface the failure in logs at least — the tool already returned
          // "Dispatched…" synchronously, so a silent throw would otherwise leave no trace.
          this.logger.warn(
            `dispatch_pipeline: starting '${name}' for #${board_task_id} in ${worktree_id} failed: ${err}`,
          ),
        );
    });
    return `Dispatched the '${name}' pipeline for #${board_task_id} in ${worktree_id}. Stages run as specialist sessions; it pauses at the plan and PR gates for your review.`;
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
