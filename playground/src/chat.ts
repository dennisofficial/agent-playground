import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { botById, resolveWorkerModel, ROSTER } from './employees/index.js';
import { createJob, getJob, latestJob } from './jobs.js';
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
  async ({ task }, config) => {
    const id = getIdentity(config);
    // The engine is the dispatching employee's locked engine — there is no per-dispatch override.
    const engineName = (botById(id.selfAgent) ?? ROSTER[0]).engine;
    // ALWAYS planning mode (read-only). The bot can only ever create a read-only PLAN job; a
    // write-capable EXECUTE job is created exclusively by the human-approval path (executeApprovedPlan),
    // so the AI can never authorize its own code changes. A pure question/investigation just answers and
    // ends DONE; a task that would mutate the repo comes back with a plan for Dennis to approve.
    const job = createJob(task, id.surface, engineName, id.selfAgent, id.company, 'plan');
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
    return `Started ${job.id} (${engineName}): "${task}". It explores read-only, then either answers directly (if it's just a question) or comes back with a plan for Dennis to approve in the terminal before anything is built — you can't start a build yourself. You're notified once when it reports back.`;
  },
  {
    name: 'dispatch_job',
    description:
      'Hand yourself a full unit of real work (filesystem/shell/build/test/codebase exploration) to run in your background thread. Returns immediately with a job id; you are notified once when it reports back. It ALWAYS starts read-only: a pure question/investigation is answered directly; anything that would change the repo comes back as a plan for Dennis to approve in the terminal before it builds — you cannot start a build yourself. Calling this ENDS YOUR TURN — there is no follow-up reply afterward, so put any brief first-person heads-up (e.g. "On it — give me a bit") in THIS message\'s text, not as a separate message, and never add an "I\'ll let you know when I\'m done" after.',
    schema: z.object({
      task: z.string().describe('A clear, self-contained description of the work to do.'),
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

// Plan approval is NOT a bot tool — it's a human-only action. The execute-spawn logic lives in
// executeApprovedPlan (approval.ts), reached only via the conductor's approvePlan (driven by the
// terminal `/approve` command, a future Slack button). The model has no way to approve its own plan or
// start a build — that's the code-level human-in-the-loop gate.

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
    "first-person heads-up as THIS message's text, then dispatch_job + end_turn together) so you do " +
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
  check_job,
  cancel_job,
  recent_work,
  end_turn,
  ...memoryTools,
  ...taskTools,
];
