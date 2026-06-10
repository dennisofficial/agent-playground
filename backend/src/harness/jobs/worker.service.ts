import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EngineRegistry } from '../engines/engine.registry';
import { withActiveRoot } from '../engines/guard';
import { EmployeeRegistry } from '../employees/employee.registry';
import { PersonaService } from '../employees/persona.service';
import { WorklogStore } from '../memory/worklog-store';
import { JOB_REGISTRY, type JobRegistry } from './job-registry.port';

/**
 * The bots' background-execution thread. A dispatched task runs to completion on its engine (the
 * engine loops internally until done), streams normalized events into the progress buffer, and
 * reports ONCE — marking the job 'done' (or 'awaiting' only if it explicitly needs human input).
 * That single `update` is the wake signal the conductor relays through the bot. continueWork
 * resumes the rare 'awaiting' case; there is no step-by-step check-in loop.
 *
 * (Ported from playground/src/worker.ts. The worktree/ticket machinery is deliberately dropped —
 * jobs are read-only PLAN passes this pass and run directly in WORKER_ROOT. Per-job isolation
 * worktrees/Docker return with the execute flow.)
 */

/** Cap on background turns per job. UNCAPPED per Dennis (2026-06-09) — jobs run fully autonomous to
 * completion. Restore a finite cap when unattended operation needs a backstop (paired with the
 * progress/cost circuit breaker in the conductor). */
export const MAX_TURNS = Number.POSITIVE_INFINITY;

export interface ActionResult {
  ok: boolean;
  reason?: string;
}

/**
 * A finished run reports as 'done' — unless it explicitly ended needing a human (STATUS: QUESTION /
 * BLOCKED), which parks it in 'awaiting' so the chat-self can get input. The worker ends its report
 * with the status line, so only inspect the tail — a report can legitimately mention "STATUS: …"
 * in its body, which must not count.
 */
export function statusFromReport(report: string): 'done' | 'awaiting' {
  const tail = report.trimEnd().split('\n').slice(-5).join('\n');
  const matches = [...tail.matchAll(/^[\s>*_-]*STATUS:\s*(DONE|BLOCKED|QUESTION|PROGRESS)\b/gim)];
  const tag = matches.at(-1)?.[1]?.toUpperCase();
  return tag === 'QUESTION' || tag === 'BLOCKED' ? 'awaiting' : 'done';
}

@Injectable()
export class WorkerService {
  private readonly logger = new Logger(WorkerService.name);

  // Live AbortControllers for in-flight worker runs, keyed by job id — the handle `cancelJob`
  // aborts. (In-process for now; when workers move to containers this becomes a remote stop signal.)
  private controllers = new Map<string, AbortController>();

  constructor(
    @Inject(JOB_REGISTRY) private readonly jobs: JobRegistry,
    private readonly engines: EngineRegistry,
    private readonly employees: EmployeeRegistry,
    private readonly persona: PersonaService,
    private readonly worklog: WorklogStore,
    private readonly env: EnvService,
  ) {}

  /**
   * The directory workers are jailed to. Required at dispatch time (not boot) so a missing value
   * fails the dispatch loudly instead of letting a worker loose in an arbitrary cwd.
   */
  workerRoot(): string {
    const root = this.env.get('WORKER_ROOT');
    if (!root) {
      throw new Error('WORKER_ROOT is not set — set it to the absolute path worker engines are jailed to.');
    }
    return root;
  }

  /**
   * Run a job's background thread to completion on its engine. `message` is the original task on
   * the first run, or the chat-self's answer when resuming an 'awaiting' job. The engine already
   * loops internally until the whole task is done, so this reports once. Fire-and-forget — errors
   * are caught here so there's never an unhandled rejection.
   */
  async runWorkerTurn(jobId: string, message: string): Promise<void> {
    const job = await this.jobs.get(jobId);
    if (!job) return;
    const ac = new AbortController();
    this.controllers.set(jobId, ac);
    try {
      const bot = this.employees.byId(job.ownerBot) ?? this.employees.fallbackOwner();
      // Per-phase model tiering: PLAN runs on a high-reasoning model + max effort; EXECUTE on the
      // cheaper everyday model. `planning` makes the plan pass read-only at the engine seam.
      const { model, effort } = this.employees.resolveWorkerModel(bot, job.mode);
      const cwd = this.workerRoot();

      this.logger.log(
        `${jobId} — ${job.mode} on ${model ?? `${job.engine} default`}${effort ? ` (effort:${effort})` : ''} (${bot.name})`,
      );
      // Jail the in-process langgraph tools to the worker root for the run (claude/codex also get
      // `cwd` for their own subprocess sandbox).
      const { result, sessionId } = await withActiveRoot(cwd, () =>
        this.engines.get(job.engine).run({
          task: message,
          cwd,
          systemPrompt: this.persona.workerPromptFor(bot, job.mode),
          sessionId: job.sessionId,
          model,
          effort,
          planning: job.mode === 'plan',
          onEvent: (e) => void this.jobs.appendProgress(jobId, e),
          signal: ac.signal,
        }),
      );
      // Cancelled while we were finishing up: discard the result, don't mark done or relay.
      if (ac.signal.aborted) return;
      const report = result || '(no report)';
      const status = statusFromReport(report);

      await this.jobs.update(jobId, {
        status,
        sessionId,
        lastReport: report,
        turns: job.turns + 1,
        ...(status === 'done' ? { result: report } : {}),
      });
      // Record completed work to the durable log so standups / "what did you do" have a real answer.
      if (status === 'done') {
        await this.worklog
          .logWork({ ownerBot: job.ownerBot, project: job.project, task: job.task, summary: report.slice(0, 600) })
          .catch(() => {});
      }
    } catch (err) {
      // An abort surfaces here as a thrown error — that's a cancellation, not a failure.
      if (ac.signal.aborted) await this.jobs.update(jobId, { status: 'cancelled' });
      else {
        await this.jobs.update(jobId, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.controllers.delete(jobId);
    }
  }

  /**
   * Cancel a job the owner no longer wants: abort its running worker (the engine kills its child
   * process / aborts its stream) and mark it 'cancelled' so its result is discarded, not relayed.
   */
  async cancelJob(jobId: string): Promise<ActionResult> {
    const job = await this.jobs.get(jobId);
    if (!job) return { ok: false, reason: `No job "${jobId}".` };
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
      return { ok: false, reason: `${jobId} is already ${job.status} — nothing to cancel.` };
    }
    const controller = this.controllers.get(jobId);
    await this.jobs.update(jobId, { status: 'cancelled' }); // mark first so checks exclude this job
    controller?.abort();
    return { ok: true };
  }

  /**
   * Resume a task that came back needing input (an 'awaiting' job), feeding it the human's answer.
   * This is the ONLY way work continues past one run. Guarded: only an 'awaiting' job under the
   * turn cap can be resumed.
   */
  async continueWork(jobId: string, note: string): Promise<ActionResult> {
    const job = await this.jobs.get(jobId);
    if (!job) return { ok: false, reason: `No job "${jobId}".` };
    if (job.status !== 'awaiting') {
      return { ok: false, reason: `${jobId} is ${job.status}, not awaiting input — nothing to resume.` };
    }
    if (job.turns >= MAX_TURNS) return { ok: false, reason: `${jobId} reached its ${MAX_TURNS}-run limit.` };
    await this.jobs.update(jobId, { status: 'running', version: job.version + 1 });
    void this.runWorkerTurn(jobId, note);
    return { ok: true };
  }

  /** Render a job's recent steps as a compact, narratable string for `check_job`. */
  async getJobState(jobId: string): Promise<string> {
    const events = await this.jobs.progress(jobId);
    if (events.length === 0) return 'No activity yet — just getting started.';

    const lines: string[] = [];
    for (const e of events.slice(-12)) {
      if (e.kind === 'text') lines.push(`thinking: ${e.text.slice(0, 200)}`);
      else if (e.kind === 'tool') lines.push(`→ called ${e.name}${e.detail ? ` (${e.detail})` : ''}`);
      else if (e.kind === 'result') lines.push(`  result: ${e.text.slice(0, 160).replace(/\s+/g, ' ')}`);
    }
    return lines.join('\n') || 'Working…';
  }

  /** Abort every in-flight worker run (graceful shutdown). */
  abortAll(): void {
    for (const [jobId, controller] of this.controllers) {
      this.logger.log(`Aborting in-flight job ${jobId} (shutdown)`);
      controller.abort();
    }
  }
}
