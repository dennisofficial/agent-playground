import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { Inject, Logger } from '@nestjs/common';
import { z } from 'zod';
import { recallProjects } from '../../domain/identity';
import { BoardStore } from '../../memory/board-store';
import { EmployeeRegistry } from '../../employees/employee.registry';
import {
  DESIGN_ROLE,
  PipelineRunnerService,
} from '../../sessions/pipeline-runner.service';
import {
  SESSION_REGISTRY,
  type SessionRegistry,
} from '../../sessions/session-registry.port';
import { WorktreeService } from '../../worktrees/worktree.service';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * The orchestrator's pipeline tools. `dispatch_pipeline` runs a greenlit board task as a dynamic
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
    .describe(
      'The team-board task (#N) to run — one Dennis greenlit, whether he asked for it directly or you pulled it off the backlog with his go-ahead. No special status is required first.',
    ),
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
  overview: z
    .string()
    .optional()
    .describe(
      'For a feature: the high-level plan you and Dennis agreed on while scoping (intent, stack, constraints, how the sections fit). Seeds EVERY section\'s planning so each is grounded in the whole, not just its brief.',
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
    'Dispatch a board task Dennis has greenlit — one he asked for directly, or one you pulled off the backlog with his go-ahead. A feature runs your declared sections in order — each planned just-in-time (and gated for his approval at the plan gate) then built phase-by-phase with a fresh review after each, all in one worktree, shipping one PR. A bugfix runs a single execute session straight to a PR. It advances automatically; you are notified at each gate.';
  readonly schema = dispatchSchema;
  readonly refreshesContext = ['pipelines'] as const;
  private readonly logger = new Logger(DispatchPipelineTool.name);

  constructor(
    private readonly board: BoardStore,
    private readonly worktrees: WorktreeService,
    private readonly employees: EmployeeRegistry,
    private readonly runner: PipelineRunnerService,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  async execute(
    { board_task_id, worktree_id, kind, sections, role, overview }: z.infer<
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
      if (r !== DESIGN_ROLE && !this.employees.byId(r))
        return `Unknown phase-config '${r}'. Use a real one (e.g. 'phase_backend'), or '${DESIGN_ROLE}' for a design gate.`;

    // GROUNDING guard (feature only): the section breakdown is the dangerous joint — it must trace to
    // a real code read, not a memory/assumption decomposition. This is a SATISFIABLE gate, NOT a
    // bypassable one — the only way past is to investigate (cheap + async) or run trivial work as a
    // bugfix; there is deliberately no override flag (a flag just teaches the model to flip it, turning
    // the guard into theater). A still-running investigate counts — the reflexive fire is in flight,
    // and its relay-back carries the grounded breakdown.
    if (runKind === 'feature') {
      const sessions = await this.sessions.list({ ownerBot: id.selfAgent });
      const grounded = sessions.some(
        (s) =>
          s.boardTaskId === board_task_id &&
          s.mode === 'investigate' &&
          (s.status === 'idle' || s.status === 'running'),
      );
      if (!grounded)
        return `Before I dispatch #${board_task_id} as a feature, the section breakdown should trace to a real read of the code, not memory — I don't see an investigate() tied to this task. Ground it first: investigate(question, board_task_id: ${board_task_id}) and I'll dispatch the moment it reports back (read-only and non-blocking). If it's too small to need a breakdown, run it as a bugfix instead.`;
    }

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
          overview: runKind === 'feature' ? overview : undefined,
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

const attachDesignSchema = z.object({
  board_task_id: z
    .number()
    .int()
    .describe('The board task (#N) whose pipeline is paused at a design gate.'),
  zip_path: z
    .string()
    .describe(
      'LOCAL filesystem path to the design zip (specs + reference) Dennis exported from the design tool.',
    ),
});

@HarnessTool()
export class AttachDesignTool
  implements IHarnessTool<typeof attachDesignSchema>
{
  readonly name = 'attach_design';
  readonly description =
    'Attach the design artifact Dennis produced to a pipeline paused at its design gate — unzips it into the worktree (design/) and resumes the run: the next section plans/builds against it. Use the LOCAL path he gives you.';
  readonly schema = attachDesignSchema;
  readonly refreshesContext = ['pipelines'] as const;

  constructor(private readonly runner: PipelineRunnerService) {}

  async execute(
    { board_task_id, zip_path }: z.infer<typeof attachDesignSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const r = await this.runner.attachDesign(
      ctx.identity.team,
      board_task_id,
      zip_path,
    );
    return r.message;
  }
}

const answerSectionSchema = z.object({
  board_task_id: z
    .number()
    .int()
    .describe('The board task (#N) whose section plan/build session asked questions.'),
  answers: z
    .string()
    .describe('Your consolidated answers to ALL of its questions, in one message.'),
  regrouped_phases: z
    .array(
      z.object({
        phase_id: z
          .number()
          .int()
          .describe('A pending (not-yet-built) phase id from the section plan.'),
        group: z
          .number()
          .int()
          .describe(
            'The coding-session group to place it in — consecutive phases sharing a group build in ONE engine context.',
          ),
      }),
    )
    .optional()
    .describe(
      'OPTIONAL: re-group the REMAINING (not-yet-built) phases of this section into different coding sessions — e.g. the running build realized phases 4–5 should share its context. Only future phases can move (already-building/done phases are fixed); list every pending phase exactly once. This is a mechanics call (same phases, new packaging) — no re-approval.',
    ),
});

@HarnessTool()
export class AnswerSectionTool
  implements IHarnessTool<typeof answerSectionSchema>
{
  readonly name = 'answer_section';
  readonly description =
    "Answer the questions a pipeline section's plan/build session raised — delivers your answers into that session so it can finish (a revised plan comes back, or more questions). Use THIS for pipeline sections, not reply_session (they aren't your sessions). Answer technical HOWs yourself; bring product WHAT/WHYs to Dennis first. If a build session proposes re-grouping its remaining phases, pass regrouped_phases to reshape them before it resumes.";
  readonly schema = answerSectionSchema;
  readonly refreshesContext = ['pipelines'] as const;

  constructor(private readonly runner: PipelineRunnerService) {}

  async execute(
    { board_task_id, answers, regrouped_phases }: z.infer<
      typeof answerSectionSchema
    >,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const r = await this.runner.answerSectionQuestions(
      ctx.identity.team,
      board_task_id,
      answers,
      regrouped_phases?.map((p) => ({ id: p.phase_id, group: p.group })),
    );
    return r.message;
  }
}

const insertSectionSchema = z.object({
  board_task_id: z
    .number()
    .int()
    .describe('The board task (#N) whose running feature pipeline to add a section to.'),
  after_section: z
    .string()
    .describe(
      'The name of the existing section to insert the new one AFTER (it lands in the still-pending tail).',
    ),
  name: z.string().describe('Name for the new section, e.g. "prompt-eng".'),
  brief: z
    .string()
    .optional()
    .describe("One-line intent for the new section (seeds its plan)."),
  role: z
    .string()
    .describe(
      "The phase-config to build the new section as, e.g. 'phase_backend'. Scopes its skills/engines.",
    ),
});

@HarnessTool()
export class InsertSectionTool
  implements IHarnessTool<typeof insertSectionSchema>
{
  readonly name = 'insert_section';
  readonly description =
    "Add a NEW section into a running feature's still-pending tail (e.g. a backend stage revealed you need a prompt-eng section). It's born pending and hits the normal plan gate when the pipeline reaches it — so this introduces real new work (gated), unlike reorder_sections. You can only insert AFTER already-committed (executed/executing) sections, never wedge before them.";
  readonly schema = insertSectionSchema;
  readonly refreshesContext = ['pipelines'] as const;

  constructor(private readonly runner: PipelineRunnerService) {}

  async execute(
    { board_task_id, after_section, name, brief, role }: z.infer<
      typeof insertSectionSchema
    >,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const r = await this.runner.insertSection(
      ctx.identity.team,
      board_task_id,
      after_section,
      { name, brief, phaseRole: role },
    );
    return r.message;
  }
}

const reorderSectionsSchema = z.object({
  board_task_id: z
    .number()
    .int()
    .describe('The board task (#N) whose running feature pipeline to reorder.'),
  order: z
    .array(z.string())
    .describe(
      'The new order of the still-PENDING sections, by name — must list every pending section exactly once. Already-building/done sections are fixed and stay put.',
    ),
});

@HarnessTool()
export class ReorderSectionsTool
  implements IHarnessTool<typeof reorderSectionsSchema>
{
  readonly name = 'reorder_sections';
  readonly description =
    "Reorder the still-PENDING sections of a running feature (same work, new order). This is a mechanics change, NOT new substance — it needs no re-approval and pauses nothing; you're just resequencing what hasn't started yet. Only pending sections move; committed (building/done) sections hold their place. Use insert_section to add new work instead.";
  readonly schema = reorderSectionsSchema;
  readonly refreshesContext = ['pipelines'] as const;

  constructor(private readonly runner: PipelineRunnerService) {}

  async execute(
    { board_task_id, order }: z.infer<typeof reorderSectionsSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const r = await this.runner.reorderSections(
      ctx.identity.team,
      board_task_id,
      order,
    );
    return r.message;
  }
}

const skipDesignSchema = z.object({
  board_task_id: z
    .number()
    .int()
    .describe('The board task (#N) whose pipeline is paused at a design gate.'),
});

@HarnessTool()
export class SkipDesignTool implements IHarnessTool<typeof skipDesignSchema> {
  readonly name = 'skip_design';
  readonly description =
    "Skip a pipeline's design gate — ships the functional version now and defers the design + its implementation. Use only when Dennis says he's too busy to design now; then ask him whether to backlog it for later.";
  readonly schema = skipDesignSchema;
  readonly refreshesContext = ['pipelines'] as const;

  constructor(private readonly runner: PipelineRunnerService) {}

  async execute(
    { board_task_id }: z.infer<typeof skipDesignSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const r = await this.runner.skipDesign(ctx.identity.team, board_task_id);
    return r.message;
  }
}

const dispatchFixupSchema = z.object({
  board_task_id: z
    .number()
    .int()
    .describe('The board task (#N) whose pipeline is paused at a review decision.'),
  guidance: z
    .string()
    .optional()
    .describe(
      "Optional steer for the fix-up session (how you read the finding / what to prioritize). The full review findings are already on the ticket, so this is just your overlay.",
    ),
});

@HarnessTool()
export class DispatchFixupSessionTool
  implements IHarnessTool<typeof dispatchFixupSchema>
{
  readonly name = 'dispatch_fixup_session';
  readonly description =
    "Resolve a review-flagged defect when a pipeline is paused at a review decision (a cross-section defect at the full-implementation review, or a section-review blocker). Opens a fresh session in the INTEGRATED worktree to fix the issue at the root cause, then auto re-runs the review and ships if clean. This is the usual call — use it for integration/seam defects, or to verify a benign finding and ship. Use reopen_section instead only when a section's PLAN was wrong.";
  readonly schema = dispatchFixupSchema;
  readonly refreshesContext = ['pipelines'] as const;

  constructor(private readonly runner: PipelineRunnerService) {}

  async execute(
    { board_task_id, guidance }: z.infer<typeof dispatchFixupSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const r = await this.runner.dispatchFixup(
      ctx.identity.team,
      board_task_id,
      guidance,
    );
    return r.message;
  }
}

const reopenSectionSchema = z.object({
  board_task_id: z
    .number()
    .int()
    .describe('The board task (#N) whose pipeline is paused at a review decision.'),
  section: z
    .string()
    .describe('The name of the section to send back to planning.'),
  defect: z
    .string()
    .describe(
      "The defect / why the section's PLAN was wrong — injected as authoritative direction for the re-plan.",
    ),
});

@HarnessTool()
export class ReopenSectionTool
  implements IHarnessTool<typeof reopenSectionSchema>
{
  readonly name = 'reopen_section';
  readonly description =
    "Send a section back to planning when a review concludes its PLAN was wrong (a design defect — the RARE path). Drops the section's built work, re-plans it with your defect note as the brief, and pauses at its plan gate for Dennis's approval. For an integration/seam defect that's just a code fix, use dispatch_fixup_session instead.";
  readonly schema = reopenSectionSchema;
  readonly refreshesContext = ['pipelines'] as const;

  constructor(private readonly runner: PipelineRunnerService) {}

  async execute(
    { board_task_id, section, defect }: z.infer<typeof reopenSectionSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const r = await this.runner.reopenSection(
      ctx.identity.team,
      board_task_id,
      section,
      defect,
    );
    return r.message;
  }
}
