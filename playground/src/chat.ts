import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { tool } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { defaultEngine, ENGINE_NAMES } from './engines/index.js';
import type { WorkerEngineName } from './engines/types.js';
import { CLI_THREAD_ID, createJob, getJob, latestJob } from './jobs.js';
import { getCheckpointer } from './memory/checkpointer.js';
import { memoryTools } from './memory/tools.js';
import { buildModel } from './model.js';
import { CHAT_PROMPT } from './persona.js';
import { grep, list_dir, read_file } from './tools.js';
import { type ActionResult, continueWork, getJobState, runWorkerTurn } from './worker.js';

// Zero's chat-side tools. The chat surface has NO filesystem/shell access itself — that lives in the
// background-execution thread (a job). This is the structural "plan-mode" boundary: chat dispatches,
// continues, finishes, and inspects its own background work; it never mutates directly.

const dispatch_job = tool(
  async ({ task, engine }) => {
    const engineName: WorkerEngineName = engine ?? defaultEngine();
    // v0: single CLI surface. v1 reads config.configurable.thread_id to route per surface.
    const job = createJob(task, CLI_THREAD_ID, engineName);
    // Fire-and-forget: the worker runs in the background, the chat turn returns immediately.
    //
    // Detach the background turn from the conductor's streaming callback context. dispatch_job runs
    // inside the chat graph's `streamMode: 'messages'` run, and LangChain propagates that run's
    // callbacks to nested runnables via AsyncLocalStorage (ensureConfig → getRunnableConfig merges,
    // not replaces — so passing `callbacks: []` wouldn't help). Without clearing the store, a
    // LangGraph turn's invoke() inherits the chat stream's message handler and its tokens/tool-calls
    // bleed into the main chat. run(undefined, …) roots the turn in a clean store. (The SDK engines
    // spawn their own subprocess and don't share the store, but this is harmless for them.)
    // `@langchain/core/singletons` is a semi-internal surface — hence this comment.
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
  async ({ jobId, note }) => {
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
  async ({ jobId }) => {
    const job = jobId ? getJob(jobId) : latestJob();
    if (!job) return jobId ? `No job "${jobId}" found.` : 'No jobs have been started yet.';
    const header = `${job.id} [${job.status}]: "${job.task}"`;
    if (job.status === 'done') return `${header}\nResult: ${job.result ?? '(none)'}`;
    if (job.status === 'failed') return `${header}\nFailed: ${job.error ?? '(unknown error)'}`;
    const progress = await getJobState(job.id);
    return `${header}\nProgress so far:\n${progress}`;
  },
  {
    name: 'check_job',
    description:
      "Check a job's progress (or the most recent job if no id is given). Returns the worker's recent steps to summarize for the user.",
    schema: z.object({
      jobId: z.string().optional().describe('The job id to check; omit for the latest job.'),
    }),
  },
);

// Lazy + memoized: ChatAnthropic's constructor throws if ANTHROPIC_API_KEY is missing.
// Building at module top-level would crash on import before Ink can render an error row.
let graph: ReturnType<typeof build> | undefined;

function build() {
  return createAgent({
    model: buildModel(),
    // Read-only tools (read_file/list_dir/grep) so Zero answers questions directly, plus the
    // background-work tools. No write/shell here — that lives in the background thread.
    tools: [read_file, list_dir, grep, dispatch_job, continue_work, check_job, ...memoryTools],
    systemPrompt: CHAT_PROMPT,
    checkpointer: getCheckpointer(),
  });
}

export const getGraph = () => (graph ??= build());
