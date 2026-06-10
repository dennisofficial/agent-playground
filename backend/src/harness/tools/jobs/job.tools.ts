import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { JOB_REGISTRY, type JobRegistry } from '../../jobs/job-registry.port';
import { WorkerService, type ActionResult } from '../../jobs/worker.service';
import { WorklogStore } from '../../memory/worklog-store';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * A bot's job tools. The chat surface has NO filesystem/shell access at all — not even reads. The
 * chat-you is a PERSON: it plans, delegates, coordinates, and remembers, but has no hands. Every
 * touch of the codebase — even a one-file read — goes through a dispatched job (WorkerService),
 * which runs to completion in a background thread scoped to WORKER_ROOT. This is the structural
 * "plan-mode" boundary. Each tool reads the calling bot's identity from the tool context (set by
 * the conductor) so jobs are scoped per bot. (Ported from playground/src/chat.ts; the board tools
 * execute_ticket/flag_scope are deliberately not in this pass.)
 */

const dispatchSchema = z.object({
  task: z.string().describe('A clear, self-contained description of the work to do.'),
});

@HarnessTool()
export class DispatchJobTool implements IHarnessTool<typeof dispatchSchema> {
  readonly name = 'dispatch_job';
  readonly description =
    'Hand yourself a full unit of real work (filesystem/shell/build/test/codebase exploration) to run in your background thread. Returns immediately with a job id; you are notified once when it reports back. It ALWAYS starts read-only: a pure question/investigation is answered directly; anything that would change the repo comes back as a plan for approval before it builds — you cannot start a build yourself. Calling this ENDS YOUR TURN — there is no follow-up reply afterward, so put any brief first-person heads-up (e.g. "On it — give me a bit") in THIS message\'s text, not as a separate message, and never add an "I\'ll let you know when I\'m done" after.';
  readonly schema = dispatchSchema;
  readonly terminal = true;

  constructor(
    @Inject(JOB_REGISTRY) private readonly jobs: JobRegistry,
    private readonly worker: WorkerService,
    private readonly employees: EmployeeRegistry,
  ) {}

  async execute({ task }: z.infer<typeof dispatchSchema>, ctx: HarnessToolContext): Promise<string> {
    const id = ctx.identity;
    // The engine is the dispatching employee's locked engine — there is no per-dispatch override.
    const engineName = (this.employees.byId(id.selfAgent) ?? this.employees.fallbackOwner()).engine;
    // ALWAYS planning mode (read-only). The bot can only ever create a read-only PLAN job; a
    // write-capable EXECUTE job will be created exclusively by the human-approval path when the
    // plan-execute flow ports — the AI can never authorize its own code changes.
    const job = await this.jobs.create({
      task,
      notifyThread: id.surface,
      engine: engineName,
      ownerBot: id.selfAgent,
      project: id.project,
      mode: 'plan',
    });
    // Fire-and-forget: the worker runs in the background, the chat turn returns immediately.
    //
    // Detach the background turn from the conductor's streaming callback context. dispatch_job runs
    // inside the chat graph's `streamMode: 'messages'` run, and LangChain propagates that run's
    // callbacks to nested runnables via AsyncLocalStorage. Without clearing the store, a LangGraph
    // turn's invoke() inherits the chat stream's message handler and its tokens/tool-calls bleed
    // into the main chat. run(undefined, …) roots the turn in a clean store.
    AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => {
      void this.worker.runWorkerTurn(job.id, task);
    });
    return `Started ${job.id} (${engineName}): "${task}". It explores read-only, then either answers directly (if it's just a question) or comes back with a plan for Dennis to approve before anything is built — you can't start a build yourself. You're notified once when it reports back.`;
  }
}

const continueSchema = z.object({
  jobId: z.string().describe('The job id to resume.'),
  note: z.string().describe("The answer to the task's question, or how to get unblocked."),
});

@HarnessTool()
export class ContinueWorkTool implements IHarnessTool<typeof continueSchema> {
  readonly name = 'continue_work';
  readonly description =
    'Resume a background task that came back NEEDING YOUR INPUT (a question or blocker), feeding it the answer so it can run to completion. Only for that case — tasks otherwise finish on their own. Instruct it in the first person; it is your own work.';
  readonly schema = continueSchema;

  constructor(
    @Inject(JOB_REGISTRY) private readonly jobs: JobRegistry,
    private readonly worker: WorkerService,
  ) {}

  async execute({ jobId, note }: z.infer<typeof continueSchema>, ctx: HarnessToolContext): Promise<string> {
    const job = await this.jobs.get(jobId);
    if (!job || job.ownerBot !== ctx.identity.selfAgent) return `Couldn't resume ${jobId}: not your job.`;
    // Resume fires fire-and-forget and must run in a clean store so a LangGraph run's callbacks
    // don't bleed into the chat stream.
    let res: ActionResult = { ok: false };
    await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, async () => {
      res = await this.worker.continueWork(jobId, note);
    });
    return res.ok
      ? `Sent your answer to ${jobId}; it's running again and will report back when done.`
      : `Couldn't resume ${jobId}: ${res.reason}`;
  }
}

const checkSchema = z.object({
  jobId: z.string().optional().describe('The job id to check; omit for your latest job.'),
});

@HarnessTool()
export class CheckJobTool implements IHarnessTool<typeof checkSchema> {
  readonly name = 'check_job';
  readonly description =
    "Check one of your jobs' progress (or your most recent if no id is given). Returns the worker's recent steps to summarize.";
  readonly schema = checkSchema;

  constructor(
    @Inject(JOB_REGISTRY) private readonly jobs: JobRegistry,
    private readonly worker: WorkerService,
    private readonly employees: EmployeeRegistry,
  ) {}

  async execute({ jobId }: z.infer<typeof checkSchema>, ctx: HarnessToolContext): Promise<string> {
    const id = ctx.identity;
    const job = jobId ? await this.jobs.get(jobId) : await this.jobs.latest(id.selfAgent);
    if (!job || job.ownerBot !== id.selfAgent) {
      return jobId ? `No job "${jobId}" found.` : 'No jobs have been started yet.';
    }
    const bot = this.employees.byId(job.ownerBot) ?? this.employees.fallbackOwner();
    const { model, effort } = this.employees.resolveWorkerModel(bot, job.mode);
    const tier = `${job.mode} on ${model ?? `${job.engine} default`}${effort ? `, effort ${effort}` : ''}`;
    const header = `${job.id} [${job.status}] (${tier}): "${job.task}"`;
    if (job.status === 'done') return `${header}\nResult: ${job.result ?? '(none)'}`;
    if (job.status === 'failed') return `${header}\nFailed: ${job.error ?? '(unknown error)'}`;
    const progress = await this.worker.getJobState(job.id);
    return `${header}\nProgress so far:\n${progress}`;
  }
}

const cancelSchema = z.object({
  jobId: z.string().optional().describe('The job id to cancel; omit for your most recent job.'),
});

@HarnessTool()
export class CancelJobTool implements IHarnessTool<typeof cancelSchema> {
  readonly name = 'cancel_job';
  readonly description =
    "Stop a background job of yours that's running (or parked awaiting input) — e.g. you dispatched the wrong thing. It aborts the worker and discards its result. Pass the job id; omit it to cancel your most recent job.";
  readonly schema = cancelSchema;

  constructor(
    @Inject(JOB_REGISTRY) private readonly jobs: JobRegistry,
    private readonly worker: WorkerService,
  ) {}

  async execute({ jobId }: z.infer<typeof cancelSchema>, ctx: HarnessToolContext): Promise<string> {
    const id = ctx.identity;
    const job = jobId ? await this.jobs.get(jobId) : await this.jobs.latest(id.selfAgent);
    if (!job || job.ownerBot !== id.selfAgent) {
      return jobId ? `No job "${jobId}" of yours to cancel.` : 'You have no jobs to cancel.';
    }
    const res = await this.worker.cancelJob(job.id);
    return res.ok
      ? `Cancelled ${job.id} ("${job.task}") — it's stopped and its result will be discarded.`
      : `Couldn't cancel ${job.id}: ${res.reason}`;
  }
}

const recentWorkSchema = z.object({
  scope: z
    .enum(['mine', 'team'])
    .optional()
    .describe("'mine' (default) for your own completed work, 'team' for everyone's."),
});

@HarnessTool()
export class RecentWorkTool implements IHarnessTool<typeof recentWorkSchema> {
  readonly name = 'recent_work';
  readonly description =
    "Your (or the team's) recently completed background work, newest first. Use this for standups or whenever someone asks what you've been working on — it's how you remember what you actually did.";
  readonly schema = recentWorkSchema;

  constructor(private readonly worklog: WorklogStore) {}

  async execute({ scope }: z.infer<typeof recentWorkSchema>, ctx: HarnessToolContext): Promise<string> {
    const id = ctx.identity;
    const entries = await this.worklog.recentWork({
      project: id.project,
      ownerBot: scope === 'team' ? undefined : id.selfAgent,
      limit: 10,
    });
    if (entries.length === 0) {
      return scope === 'team'
        ? 'No completed work is logged for the team yet.'
        : 'I have no completed work logged yet — nothing finished in a previous session.';
    }
    return entries
      .map((e) => `- [${e.completedAt.slice(0, 10)}] ${e.ownerBot}: ${e.task} — ${e.summary.slice(0, 160)}`)
      .join('\n');
  }
}

const endTurnSchema = z.object({});

/**
 * Closes the turn with no further reply. A no-op that just returns a result (so the ToolNode
 * produces a valid tool message for it — Anthropic requires a result for every tool-call id); the
 * turn actually ends because the graph treats `terminal` tools as ending the turn.
 */
@HarnessTool()
export class EndTurnTool implements IHarnessTool<typeof endTurnSchema> {
  readonly name = 'end_turn';
  readonly description =
    'End your turn right now with no further reply. Call it alongside dispatch_job (give a brief ' +
    "first-person heads-up as THIS message's text, then dispatch_job + end_turn together) so you do " +
    'not add a chatty "I\'ll let you know when I\'m done" afterward — or alone, when a message in the ' +
    'channel simply is not yours to answer.';
  readonly schema = endTurnSchema;
  readonly terminal = true;

  async execute(): Promise<string> {
    return '(turn ended)';
  }
}
