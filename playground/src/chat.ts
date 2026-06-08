import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { defaultEngine, ENGINE_NAMES } from './engines/index.js';
import type { WorkerEngineName } from './engines/types.js';
import { createJob, getJob, latestJob } from './jobs.js';
import { getIdentity } from './memory/identity.js';
import { memoryTools } from './memory/tools.js';
import { recentWork } from './memory/worklog.js';
import { grep, list_dir, read_file } from './tools.js';
import {
  type ActionResult,
  cancelJob,
  continueWork,
  getJobState,
  runWorkerTurn,
} from './worker.js';

// A bot's chat-side tools. The chat surface has NO filesystem/shell access itself — that lives in the
// background-execution thread (a job). This is the structural "plan-mode" boundary: chat dispatches,
// continues, finishes, and inspects its own background work; it never mutates directly. Each tool reads
// the calling bot's identity from the run config (set by the conductor) so jobs are scoped per bot.

const dispatch_job = tool(
  async ({ task, engine }, config) => {
    const id = getIdentity(config);
    const engineName: WorkerEngineName = engine ?? defaultEngine();
    // notifyThread = the surface this was dispatched from; ownerBot = the calling bot; company scopes
    // the work log to this project.
    const job = createJob(task, id.surface, engineName, id.selfAgent, id.company);
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
    return `Started ${job.id} (${engineName}) in the background: "${task}". It runs to completion and reports back once when it's done.`;
  },
  {
    name: 'dispatch_job',
    description:
      'Hand yourself a full unit of real work (filesystem/shell/build/test/codebase exploration) to run to completion in your background thread. Returns immediately with a job id; you are notified once when it finishes. Optionally pick which engine runs it.',
    schema: z.object({
      task: z.string().describe('A clear, self-contained description of the work to do.'),
      engine: z
        .enum(ENGINE_NAMES as [WorkerEngineName, ...WorkerEngineName[]])
        .optional()
        .describe(
          'Which engine runs it: claude (default), codex, or langgraph. Omit unless the user asks for a specific one.',
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

const check_job = tool(
  async ({ jobId }, config) => {
    const id = getIdentity(config);
    const job = jobId ? getJob(jobId) : latestJob(id.selfAgent);
    if (!job || job.ownerBot !== id.selfAgent)
      return jobId ? `No job "${jobId}" found.` : 'No jobs have been started yet.';
    const header = `${job.id} [${job.status}]: "${job.task}"`;
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

// A bot's chat-side tools. The conductor's turn graph ([bot-graph.ts](bot-graph.ts)) binds these in its
// `llm` node and runs them through a prebuilt ToolNode; this module just defines them (and their job /
// memory plumbing) in one place.
export const CHAT_TOOLS = [
  read_file,
  list_dir,
  grep,
  dispatch_job,
  continue_work,
  check_job,
  cancel_job,
  recent_work,
  ...memoryTools,
];
