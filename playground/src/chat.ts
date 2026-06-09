import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { botById, resolveWorkerModel, ROSTER } from './employees/index.js';
import { createJob, getJob, latestJob, updateJob } from './jobs.js';
import { rememberDeduped } from './memory/dedup.js';
import { getIdentity } from './memory/identity.js';
import { memoryTools, taskTools } from './memory/tools.js';
import { recentWork } from './memory/worklog.js';
import {
  type ActionResult,
  cancelJob,
  continueWork,
  getJobState,
  runWorkerTurn,
} from './worker.js';

// A bot's chat-side tools. The chat surface has NO filesystem/shell access at all — not even reads.
// The chat-you is a PERSON: it plans, delegates, coordinates, and remembers, but has no hands. Every
// touch of the codebase — even a one-file read — goes through a dispatched job (worker.ts), which runs
// to completion in a background thread scoped to the project root. (Per-job isolation — its own
// worktree/branch, container-style — is the planned direction, NOT yet built: workers currently share
// ROOT, so don't promise branches/merges.) This is the structural "plan-mode" boundary: chat
// dispatches, continues, finishes, and inspects its own background work; it never reads or mutates
// directly. Each tool reads the calling bot's identity from the run config (set by the conductor) so
// jobs are scoped per bot.

const dispatch_job = tool(
  async ({ task, plan }, config) => {
    const id = getIdentity(config);
    // The engine is the dispatching employee's locked engine — there is no per-dispatch override.
    const engineName = (botById(id.selfAgent) ?? ROSTER[0]).engine;
    // notifyThread = the surface this was dispatched from; ownerBot = the calling bot; company scopes
    // the work log to this project. plan=true starts it in planning mode (plan + confirm first).
    const job = createJob(
      task,
      id.surface,
      engineName,
      id.selfAgent,
      id.company,
      plan ? 'plan' : 'execute',
    );
    // Fire-and-forget: the worker runs in the background, the chat turn returns immediately.
    //
    // Detach the background turn from the conductor's streaming callback context. dispatch_job runs
    // inside the chat graph's `streamMode: 'messages'` run, and LangChain propagates that run's
    // callbacks to nested runnables via AsyncLocalStorage. Without clearing the store, a LangGraph
    // turn's invoke() inherits the chat stream's message handler and its tokens/tool-calls bleed into
    // the main chat. run(undefined, …) roots the turn in a clean store. (The SDK engines spawn their
    // own subprocess and don't share the store, but this is harmless for them.)
    AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => {
      void runWorkerTurn(job.id, task);
    });
    return plan
      ? `Started ${job.id} (${engineName}) in planning mode: "${task}". It reads enough to plan (read-only), then comes back with a plan + any questions. Refine it with continue_work; once it's settled and Dennis signs off, approve_plan to build it.`
      : `Started ${job.id} (${engineName}) in the background: "${task}". It runs to completion and reports back once when it's done.`;
  },
  {
    name: 'dispatch_job',
    description:
      'Hand yourself a full unit of real work (filesystem/shell/build/test/codebase exploration) to run to completion in your background thread. Returns immediately with a job id; you are notified once when it finishes. Set plan=true for ambiguous, large, or architectural tasks where the approach should be agreed first: it plans read-only on a high-reasoning model and comes back with a plan + questions. Refine it with continue_work, then approve_plan (once the human signs off) to build it on the execution model. Calling this ENDS YOUR TURN — there is no follow-up reply afterward, so put any brief first-person heads-up (e.g. "On it — give me a bit") in THIS message\'s text, not as a separate message, and never add an "I\'ll let you know when I\'m done" after.',
    schema: z.object({
      task: z.string().describe('A clear, self-contained description of the work to do.'),
      plan: z
        .boolean()
        .optional()
        .describe(
          'When true, the task plans and surfaces its approach + open questions for your confirmation before writing any code. Use for ambiguous/large/architectural work; leave off (default) for clear, contained tasks.',
        ),
    }),
  },
);

const continue_work = tool(
  async ({ jobId, note }, config) => {
    const id = getIdentity(config);
    const job = getJob(jobId);
    if (!job || job.ownerBot !== id.selfAgent) return `Couldn't resume ${jobId}: not your job.`;
    // Resume fires fire-and-forget and must run in a clean store so a LangGraph run's callbacks don't
    // bleed into the chat stream. continueWork fires it synchronously inside this callback.
    let res: ActionResult = { ok: false };
    AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => {
      res = continueWork(jobId, note);
    });
    return res.ok
      ? `Sent your answer to ${jobId}; it's running again and will report back when done.`
      : `Couldn't resume ${jobId}: ${res.reason}`;
  },
  {
    name: 'continue_work',
    description:
      'Resume a background task that came back NEEDING YOUR INPUT (a question or blocker), feeding it the answer so it can run to completion. Only for that case — tasks otherwise finish on their own. Instruct it in the first person; it is your own work.',
    schema: z.object({
      jobId: z.string().describe('The job id to resume.'),
      note: z.string().describe("The answer to the task's question, or how to get unblocked."),
    }),
  },
);

/** Drop trailing `STATUS: …` line(s) from a worker report, leaving the plan body for the execute job. */
const stripStatusLine = (report: string): string =>
  report.replace(/^[\s>*_-]*STATUS:\s*(DONE|QUESTION|BLOCKED|PROGRESS)\b.*$/gim, '').trimEnd();

const approve_plan = tool(
  async ({ jobId, edits }, config) => {
    const id = getIdentity(config);
    const planJob = getJob(jobId);
    if (!planJob || planJob.ownerBot !== id.selfAgent)
      return `Couldn't approve ${jobId}: not your job.`;
    if (planJob.mode !== 'plan') return `${jobId} isn't a planning job — nothing to approve.`;
    if (planJob.status !== 'awaiting')
      return `${jobId} is ${planJob.status}, not a plan awaiting approval.`;
    // Prefer the plan body with its trailing STATUS line stripped; but if the worker crammed the whole
    // plan INTO the STATUS: QUESTION line (leaving little body), fall back to the full report so we
    // never execute an empty plan.
    const body = stripStatusLine(planJob.lastReport ?? '');
    const plan = body.length >= 40 ? body : (planJob.lastReport ?? '').trim();
    if (!plan) return `${jobId} has no plan captured yet — let it finish planning first.`;

    // Planning is done: record the approved plan on the plan job and close it. (The conductor skips the
    // relay for an approved plan job — the execute job below is what reports back.)
    updateJob(jobId, { status: 'done', plan, result: plan });

    // Capture the approved approach into durable memory so future planning recalls the decision instead
    // of re-asking. reconcile.ts only mines HUMAN chat utterances; an approved plan is bot-authored, so
    // it would otherwise never be remembered — this is the deliberate write that closes that gap.
    void rememberDeduped({
      fact: `Approved plan for "${planJob.task}"${edits ? ' (with edits)' : ''}: ${plan.slice(0, 300)}`,
      tier: 'company',
      id,
    }).catch(() => {});

    // Spawn a SEPARATE execute job: fresh session → the cheaper EXECUTE-tier model (the plan ran on the
    // high-reasoning tier, and a session can't switch models mid-stream), mutations allowed, seeded with
    // the approved plan as its contract.
    const seeded = `Execute this APPROVED plan, end to end:\n\n${plan}${
      edits ? `\n\nAdjustments from the team to fold in first:\n${edits}` : ''
    }\n\n(Originating request: ${planJob.task})`;
    const execJob = createJob(
      seeded,
      planJob.notifyThread,
      planJob.engine,
      planJob.ownerBot,
      planJob.company,
      'execute',
    );
    updateJob(execJob.id, { planJobId: jobId });
    AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => {
      void runWorkerTurn(execJob.id, seeded);
    });
    return `Approved ${jobId}'s plan${edits ? ' with your adjustments' : ''} and started ${execJob.id} to build it on the execution model. It runs to completion and reports back when done.`;
  },
  {
    name: 'approve_plan',
    description:
      "Approve a planning job's plan (one that came back awaiting with a plan + questions) so it gets built. Optionally pass `edits` to adjust the plan before it runs. This starts a SEPARATE background job that executes the approved plan on the faster build model. Owner-scoped: only the bot that planned it can approve. Use this once the plan is settled and the human has signed off — not continue_work, which is for answering a planning question to refine the plan further.",
    schema: z.object({
      jobId: z.string().describe('The planning job id to approve.'),
      edits: z
        .string()
        .optional()
        .describe('Optional adjustments to fold into the plan before executing.'),
    }),
  },
);

const check_job = tool(
  async ({ jobId }, config) => {
    const id = getIdentity(config);
    const job = jobId ? getJob(jobId) : latestJob(id.selfAgent);
    if (!job || job.ownerBot !== id.selfAgent)
      return jobId ? `No job "${jobId}" found.` : 'No jobs have been started yet.';
    const { model, effort } = resolveWorkerModel(botById(job.ownerBot) ?? ROSTER[0], job.mode);
    const tier = `${job.mode} on ${model ?? `${job.engine} default`}${effort ? `, effort ${effort}` : ''}`;
    const header = `${job.id} [${job.status}] (${tier}): "${job.task}"`;
    if (job.status === 'done') return `${header}\nResult: ${job.result ?? '(none)'}`;
    if (job.status === 'failed') return `${header}\nFailed: ${job.error ?? '(unknown error)'}`;
    const progress = await getJobState(job.id);
    return `${header}\nProgress so far:\n${progress}`;
  },
  {
    name: 'check_job',
    description:
      "Check one of your jobs' progress (or your most recent if no id is given). Returns the worker's recent steps to summarize.",
    schema: z.object({
      jobId: z.string().optional().describe('The job id to check; omit for your latest job.'),
    }),
  },
);

const cancel_job = tool(
  async ({ jobId }, config) => {
    const id = getIdentity(config);
    const job = jobId ? getJob(jobId) : latestJob(id.selfAgent);
    if (!job || job.ownerBot !== id.selfAgent)
      return jobId ? `No job "${jobId}" of yours to cancel.` : 'You have no jobs to cancel.';
    const res = cancelJob(job.id);
    return res.ok
      ? `Cancelled ${job.id} ("${job.task}") — it's stopped and its result will be discarded.`
      : `Couldn't cancel ${job.id}: ${res.reason}`;
  },
  {
    name: 'cancel_job',
    description:
      "Stop a background job of yours that's running (or parked awaiting input) — e.g. you dispatched the wrong thing. It aborts the worker and discards its result. Pass the job id; omit it to cancel your most recent job.",
    schema: z.object({
      jobId: z.string().optional().describe('The job id to cancel; omit for your most recent job.'),
    }),
  },
);

const recent_work = tool(
  async ({ scope }, config) => {
    const id = getIdentity(config);
    const entries = recentWork({
      company: id.company,
      ownerBot: scope === 'team' ? undefined : id.selfAgent,
      limit: 10,
    });
    if (entries.length === 0)
      return scope === 'team'
        ? 'No completed work is logged for the team yet.'
        : 'I have no completed work logged yet — nothing finished in a previous session.';
    return entries
      .map(
        (e) =>
          `- [${e.completedAt.slice(0, 10)}] ${e.ownerBot}: ${e.task} — ${e.summary.slice(0, 160)}`,
      )
      .join('\n');
  },
  {
    name: 'recent_work',
    description:
      "Your (or the team's) recently completed background work, newest first. Use this for standups or whenever someone asks what you've been working on — it's how you remember what you actually did.",
    schema: z.object({
      scope: z
        .enum(['mine', 'team'])
        .optional()
        .describe("'mine' (default) for your own completed work, 'team' for everyone's."),
    }),
  },
);

// Closes the turn with no further reply. A no-op that just returns a result (so the ToolNode produces a
// valid tool message for it — Anthropic requires a result for every tool-call id); the turn actually ends
// because the graph's `afterTools` router treats `end_turn` as terminal (see bot-graph.ts). This is what
// lets a bot dispatch-and-go-quiet, or decline a message that isn't its own, without a trailing message.
const end_turn = tool(async () => '(turn ended)', {
  name: 'end_turn',
  description:
    'End your turn right now with no further reply. Call it alongside dispatch_job (give a brief ' +
    'first-person heads-up as THIS message\'s text, then dispatch_job + end_turn together) so you do ' +
    'not add a chatty "I\'ll let you know when I\'m done" afterward — or alone, when a message in the ' +
    'channel simply is not yours to answer.',
  schema: z.object({}),
});

// A bot's chat-side tools. The conductor's turn graph ([bot-graph.ts](bot-graph.ts)) binds these in its
// `llm` node and runs them through a prebuilt ToolNode; this module just defines them (and their job /
// memory plumbing) in one place.
export const CHAT_TOOLS = [
  dispatch_job,
  continue_work,
  approve_plan,
  check_job,
  cancel_job,
  recent_work,
  end_turn,
  ...memoryTools,
  ...taskTools,
];
