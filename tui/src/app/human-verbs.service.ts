import { Injectable } from '@nestjs/common';
import { cursorAfterClose } from '../domain/thread-delegation.js';
import { humanRolesFor, phaseLabel } from '../domain/phase-spec.js';
import { roleLabel } from '../domain/role-engine.js';
import {
  EThreadCondition,
  EThreadStatus,
  type EPhaseKind,
  type EThreadRole,
} from '../generated/prisma/enums.js';
import type { Phase, Thread } from '../generated/prisma/client.js';
import { JobRepository } from '../store/job.repository.js';
import { ThreadRepository } from '../store/thread.repository.js';
import { enterPhase } from './phase-transition.js';
import { SessionManagerService } from './session-manager.service.js';
import { ThreadSeamService } from './thread-seam.service.js';
import { TurnRunnerService } from './turn-runner.service.js';

/**
 * The moves Dennis makes himself: start a phase, open a thread, close a thread.
 *
 * A service of its own rather than three more methods on `ThreadSeamService`, and not because that
 * file is over the cap. **Nothing here is reachable from a tool.** The seam exists to hold a genuine
 * cycle — a turn needs a tool list, and the tool list contains the tools that fire turns — and these
 * verbs sit outside it entirely: they are called from a page, they have no `ToolContext`, and they
 * return nothing to an agent. Depending on the seam one-way is the honest shape.
 *
 * None of them consults `PhaseSpec.next`. That enum rails the AGENT — it is what `advance_phase`
 * may propose — and the human was never railed by it (design 02, design 08 §6). It decides the order
 * of a menu here and nothing else.
 */
@Injectable()
export class HumanVerbsService {
  constructor(
    private readonly jobRepository: JobRepository,
    private readonly threadRepository: ThreadRepository,
    private readonly sessionManagerService: SessionManagerService,
    private readonly threadSeamService: ThreadSeamService,
    private readonly turnRunnerService: TurnRunnerService,
  ) {}

  /**
   * The phase a menu is drawn against. Read rather than derived from the thread list: both creation
   * verbs act on the CURRENT phase — the highest ordinal — and a page that inferred it from the last
   * row it happened to have loaded would act on a stale one the moment an agent moved the job.
   */
  async currentPhase(jobId: string): Promise<Phase> {
    return this.jobRepository.currentPhase(jobId);
  }

  /**
   * **Start a phase.** The fourth creation trigger, alongside context pressure, the agent and an
   * external event — and the one that makes a job with nothing running re-enterable at all.
   *
   * It writes NO `Transition` row, deliberately. A transition is a *proposal*: the model exists
   * because propose→confirm is async across hours, and its `raisedBy` column names who asked. There
   * is no ask here — Dennis is both parties, decided and executed in one keypress — so a row born
   * confirmed in the same statement would record an ask that never happened, under a source
   * (`agent` or `gate`) that would be false. A phase with no confirmed transition naming it in
   * `createdPhaseId` is exactly, and readably, a phase the human started.
   *
   * Open threads in the phase being left are NOT closed. The harness must never silently kill a
   * working agent — the same rule `notLastOpenThreadRefusal` states for the agent's own advance —
   * and starting a phase beside a still-running builder is Dennis's call to make.
   */
  async startPhase(args: {
    jobId: string;
    kind: EPhaseKind;
    cwd: string;
  }): Promise<{ phase: Phase; thread: Thread }> {
    const { job, phase, thread } = await enterPhase({
      jobRepository: this.jobRepository,
      threadRepository: this.threadRepository,
      sessionManagerService: this.sessionManagerService,
      jobId: args.jobId,
      to: args.kind,
      // Nobody handed over. The new thread opens on the phase's OWN words rather than a borrowed
      // hand-off, which is what `transitionSeedHandoff` already does for a thread-less proposal.
      proposer: null,
      handoff: null,
    });

    await this.threadSeamService.seed({ job, thread, cwd: args.cwd });
    return { phase, thread };
  }

  /**
   * **Open a thread in the current phase.** No hand-off and no `openedByThreadId`: a thread Dennis
   * opened has nobody waiting on it, so it hands the cursor on by the sibling rule when it closes
   * rather than reporting back to an opener that does not exist.
   *
   * **And nothing is seeded — it opens BLANK, on whatever he types.** This used to fire the phase's
   * opening words as a `seed` turn, which meant pressing `n` inside a charting phase was answered
   * by an agent that had read `map.md`, listed the frontier and proposed a ticket, all before he
   * had said a word. That is right for a thread that arrives with a hand-off and wrong for one a
   * human opened: the opening exists to orient a thread nobody is there to brief, and here somebody
   * is — he is about to type. `JobStartService` already settles this for a job's first thread ("the
   * transcript opens on what the human actually typed"), and a thread opened by hand is the same
   * act one level down.
   *
   * The phase's standing `instructions` still ride every turn, deliberately: the phase is still the
   * phase. `generic` is the role for work that is not this job's work — see `HUMAN_ONLY_ROLES`.
   *
   * A consequence worth naming: no session is opened here either, because nothing runs. The thread
   * mints its first session when the conversation opens on it, which is also what stops it growing
   * a rotation seam between the seed and his first message.
   */
  async openThread(args: {
    jobId: string;
    role: EThreadRole;
    cwd: string;
  }): Promise<Thread> {
    const phase = await this.jobRepository.currentPhase(args.jobId);
    // Belt to the menu's braces, exactly as the tool paths do it: the menu is built from
    // `humanRolesFor`, so this can only fire against a page holding a phase the job has since left.
    // It is the HUMAN's list — wider than the agent's by the human-only roles, which is the one
    // asymmetry between these two doors.
    const roles = humanRolesFor(phase.kind);
    if (!roles.includes(args.role)) {
      throw new Error(
        `the ${phaseLabel(phase.kind)} phase does not host a ${roleLabel(args.role)} thread`,
      );
    }

    // Joins the current phase and becomes `Job.activeThreadId` — the cursor follows the work.
    return this.sessionManagerService.openThread(args.jobId, args.role);
  }

  /**
   * **Close a thread by hand**, including the last open one.
   *
   * `lastOpenThreadRefusal` is deliberately NOT evaluated: it belongs to `complete_thread`, where it
   * stops an AGENT emptying a phase by accident. A phase with nothing in it is a legal, expected
   * state — it is exactly what a shipped job is — and the two verbs above are what re-enter it.
   *
   * `abandoned` is the condition: it is reserved for precisely this, unemittable by an agent, and it
   * is what stops a closed row needing a transcript read to interpret.
   */
  async closeThread(args: {
    jobId: string;
    threadId: string;
  }): Promise<{ cursorThreadId: string | null }> {
    const thread = await this.threadRepository.findById(args.threadId);
    if (!thread) throw new Error(`no thread ${args.threadId}`);
    if (thread.status === EThreadStatus.closed) {
      throw new Error('this thread is already closed');
    }

    // Read BEFORE the close, because after it this thread is no longer one of the phase's open ones
    // and the cursor rule is about the phase as it stood when the key was pressed.
    const openThreads = await this.threadRepository.openInPhase(thread.phaseId);

    // Turns are subprocesses of this process and do not notice a row changing underneath them, so a
    // close that skipped this would leave an agent writing into a thread that has ended.
    await this.turnRunnerService.interrupt(thread.id);
    await this.sessionManagerService.closeThread(thread);
    // No resolution: nobody wrote one. An invented one would be worse than the absence.
    await this.threadRepository.recordOutcome({
      threadId: thread.id,
      condition: EThreadCondition.abandoned,
    });

    const target = cursorAfterClose({ closing: thread, openThreads });
    // `null` means nothing else is open, and the cursor STAYS on the thread just closed rather than
    // being cleared. `Job.activeThreadId` is what opening a job resolves, so clearing it would make
    // the one state this ticket exists to fix — a job with nothing running — unopenable again.
    if (target) await this.jobRepository.setActiveThread(args.jobId, target.threadId);

    return { cursorThreadId: target?.threadId ?? null };
  }
}
