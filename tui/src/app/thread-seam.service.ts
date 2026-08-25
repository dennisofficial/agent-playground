import { Injectable, Logger } from '@nestjs/common';
import { EHarnessVariant } from '../domain/message.js';
import type { RotationSections } from '../domain/rotation-handoff.js';
import type { SeedHandoff } from '../domain/thread-handoff.js';
import type {
  EPhaseKind,
  EThreadCondition,
  EThreadRole,
} from '../generated/prisma/enums.js';
import type { Job, Phase, Thread } from '../generated/prisma/client.js';
import { JobRepository } from '../store/job.repository.js';
import { ThreadRepository } from '../store/thread.repository.js';
import {
  TransitionRepository,
  type TransitionRow,
} from '../store/transition.repository.js';
import { ContextFolderService } from './context-folder.service.js';
import { PhaseBriefService } from './phase-brief.service.js';
import { PullRequestService } from './pull-request.service.js';
import { advancePhaseVerb, confirmPhaseVerb, declinePhaseVerb } from './phase-verbs.js';
import { rotateForHandoff } from './session-rotation.js';
import {
  advanceToSuccessor,
  completeCallerThread,
  openDelegateThread,
} from './thread-delegation.js';
import { ServiceRegistryService } from './service-registry.service.js';
import { SessionManagerService } from './session-manager.service.js';
import { TaskService } from './task.service.js';
import { fireHarnessTurn, seedThread, type SeedDeps } from './thread-seed.js';
import { toolsForThread } from './tools/context.js';
import type { AtlasTool, ToolActions, ToolContext } from './tools/tool.js';
import { TurnRunnerService } from './turn-runner.service.js';
import { WorktreeService } from './worktree.service.js';

/**
 * The seam: opening a thread's first turn, and moving work from one thread to the next.
 *
 * One service rather than two because the two halves are mutually recursive — seeding a successor
 * fires a turn, and a turn needs a tool list, and the tool list contains the tool that seeds a
 * successor. Split across services that is a DI cycle; held together it is a private method call,
 * and the class stays small because every decision inside it is a pure function in `domain/`.
 *
 * It implements `ToolActions` and hands ITSELF to the registry, which is what closes that loop
 * without a port, a token or a `forwardRef`.
 */
@Injectable()
export class ThreadSeamService implements ToolActions {
  private readonly logger = new Logger(ThreadSeamService.name);

  constructor(
    private readonly jobRepository: JobRepository,
    private readonly threadRepository: ThreadRepository,
    private readonly transitionRepository: TransitionRepository,
    private readonly sessionManagerService: SessionManagerService,
    private readonly phaseBriefService: PhaseBriefService,
    private readonly contextFolderService: ContextFolderService,
    private readonly turnRunnerService: TurnRunnerService,
    /**
     * `ToolActions.tasks`, satisfied by HOLDING rather than implementing — public, and named for the
     * field the type asks for, because this class hands `this` to the registry. The task list is the
     * one action set that is not a structural move, so it keeps its own owner.
     */
    readonly tasks: TaskService,
    /**
     * `ToolActions.pullRequest`, held for the same reason and in the same way. Writing down the
     * job's pull request number moves nothing structural — no phase, no thread, no cursor — so it is
     * a service this class carries to the registry rather than a fifth verb it implements.
     */
    readonly pullRequest: PullRequestService,
    /**
     * `ToolActions.services`, and the third of these. A dev server outliving a turn moves nothing
     * structural either — and unlike the other two it is not even thread-scoped, which is exactly why
     * it is a job-keyed singleton carried to the registry rather than anything a tool closure holds.
     */
    readonly services: ServiceRegistryService,
    /**
     * `ToolActions.worktree`, held on the same terms. Taking a worktree moves nothing structural
     * either — same phase, same thread, same cursor — it only changes the directory the job's later
     * turns run in, and `WorktreeService` is already the one place allowed to write that.
     */
    readonly worktree: WorktreeService,
  ) {}

  /** What `thread-seed.ts` needs from the container. One place, because two call sites want it. */
  private get seedDeps(): SeedDeps {
    return {
      phaseBriefService: this.phaseBriefService,
      sessionManagerService: this.sessionManagerService,
      turnRunnerService: this.turnRunnerService,
      toolsFor: (args) => this.toolsFor(args),
      onError: (message) => this.logger.error(message),
    };
  }

  /**
   * The tools a thread's turns may call. Resolved when the thread is opened, not per turn: a thread
   * never changes job, phase or role, so the surface cannot move under it.
   */
  async toolsFor(args: {
    job: Job;
    thread: Thread;
    cwd: string;
  }): Promise<readonly AtlasTool[]> {
    return toolsForThread({
      jobRepository: this.jobRepository,
      // Itself, which is what closes the tools-need-turns-need-tools loop.
      actions: this,
      ...args,
    });
  }

  /**
   * Atlas's opening words in a thread nobody has opened yet. The turn is fired, not awaited — see
   * `thread-seed.ts`.
   */
  async seed(args: {
    job: Job;
    thread: Thread;
    cwd: string;
    handoff?: SeedHandoff;
  }): Promise<void> {
    return seedThread({ ...this.seedDeps, ...args });
  }

  /**
   * `open_thread`: delegate and stay open. The caller keeps its turn, its session and its place; the
   * delegate takes the cursor and the human with it, and reports back by closing.
   */
  async openThread(args: {
    ctx: ToolContext;
    role: EThreadRole;
    brief: string;
    attach: readonly string[];
  }): Promise<string> {
    return openDelegateThread({
      threadRepository: this.threadRepository,
      sessionManagerService: this.sessionManagerService,
      contextFolderService: this.contextFolderService,
      seed: (seeded) => this.seed(seeded),
      ...args,
    });
  }

  /**
   * `complete_thread`: close the caller, and hand the cursor on — to the thread waiting on this
   * answer, which also gets a turn, or to a sibling by rule.
   */
  async completeThread(args: {
    ctx: ToolContext;
    condition: EThreadCondition;
    resolution: string;
  }): Promise<string> {
    return completeCallerThread({
      jobRepository: this.jobRepository,
      threadRepository: this.threadRepository,
      sessionManagerService: this.sessionManagerService,
      // A boundary the opener has to act on, delivered where every harness event already lands: at
      // a turn boundary, in its own name, as a message its transcript keeps.
      report: (reported) =>
        fireHarnessTurn({
          ...this.seedDeps,
          ...reported,
          harnessVariant: EHarnessVariant.handoff,
          prompt: () => reported.prompt,
        }),
      ...args,
    });
  }

  /**
   * `advance_thread`: close the caller, open exactly ONE successor, carry the hand-off, move the
   * cursor. No confirmation — a thread boundary is not a human boundary.
   */
  async advanceThread(args: {
    ctx: ToolContext;
    role: EThreadRole;
    handoff: string;
    attach: readonly string[];
    carry: readonly number[];
  }): Promise<string> {
    return advanceToSuccessor({
      threadRepository: this.threadRepository,
      sessionManagerService: this.sessionManagerService,
      contextFolderService: this.contextFolderService,
      seed: (seeded) => this.seed(seeded),
      // The tasks the agent named follow the work across the thread boundary — copied onto the
      // successor as its OWN rows, which is what makes those numbers updatable. See `carriedTasks`.
      carryTasks: (moved) => this.tasks.carryForward(moved),
      ...args,
    });
  }

  /**
   * `rotate`: end this session and open the next one on the same thread, carrying the four-section
   * report. One act — a hand-off written first and rotated second leaves a window in which the agent
   * keeps spending the context it has just declared spent.
   */
  async rotate(args: {
    ctx: ToolContext;
    sections: RotationSections;
    attach: readonly string[];
  }): Promise<string> {
    // Alone among the five seam tools, `rotate`'s successor runs on the CALLER's lane and queues
    // behind the whole of its `execute` — so a turn held on background work stalls the next session's
    // first turn for as long as that work runs, which is the window this tool exists to close. It buys
    // nothing either: rotation tears the CLI down and takes the tasks with it regardless.
    this.turnRunnerService.stopHolding(args.ctx.thread.id);
    return rotateForHandoff({
      sessionManagerService: this.sessionManagerService,
      contextFolderService: this.contextFolderService,
      seed: (seeded) => this.seed(seeded),
      // The task list rides the rotation hand-off itself, because a rotation keeps the SAME thread
      // and the numbers the next leg inherits are already live. A successor takes the same list by
      // the other route — `carryForward` copies the rows onto it — so the two seams both carry the
      // plan and neither one carries a number that does not resolve.
      tasks: () => this.tasks.section(args.ctx.thread.id),
      ...args,
    });
  }

  /**
   * `advance_phase`: raise a proposal, and return. **Nothing transitions here** — the row is the
   * ask, and it outlives the turn, the session and the process, because a parked confirmation is a
   * multi-hour event and a query held open across it is what this design exists to avoid.
   *
   * Where the phase being left exits without asking, that same proposal is confirmed the instant it
   * is raised — written first either way, so an automatic exit leaves the audit a confirmed one
   * leaves, and confirmation has exactly one implementation.
   */
  async advancePhase(args: {
    ctx: ToolContext;
    kind: EPhaseKind;
    reason: string;
    handoff: string;
    attach: readonly string[];
  }): Promise<string> {
    return advancePhaseVerb({
      jobRepository: this.jobRepository,
      transitionRepository: this.transitionRepository,
      contextFolderService: this.contextFolderService,
      ...args,
    });
  }

  /** What is waiting on the human in this job — the confirm overlay's whole query. */
  async pendingTransitions(jobId: string): Promise<TransitionRow[]> {
    return this.transitionRepository.pendingForJob(jobId);
  }

  /**
   * `y`. Create the phase, open its first thread, seed it from the hand-off, close the thread that
   * proposed it — the writes in `materialiseTransition`, and then the one act that has to happen
   * here, because seeding is what this class exists to own.
   */
  async confirmTransition(args: {
    transitionId: string;
    cwd: string;
  }): Promise<{ phase: Phase; thread: Thread }> {
    return confirmPhaseVerb({
      jobRepository: this.jobRepository,
      threadRepository: this.threadRepository,
      transitionRepository: this.transitionRepository,
      sessionManagerService: this.sessionManagerService,
      contextFolderService: this.contextFolderService,
      seed: (seeded) => this.seed(seeded),
      ...args,
    });
  }

  /**
   * `n`. The row stays, with the reason — a decline is the data that would later say a trigger is
   * mistuned, and it is recorded nowhere else. Nothing else happens, deliberately: the proposing
   * thread stays open and Dennis says why in the composer he is already looking at, which is a
   * conversation rather than a mechanism.
   */
  async declineTransition(args: {
    transitionId: string;
    reason?: string;
  }): Promise<void> {
    return declinePhaseVerb({ transitionRepository: this.transitionRepository, ...args });
  }
}
