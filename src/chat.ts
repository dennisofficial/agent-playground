import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { createJob, getJob, latestJob } from './jobs.js';
import { buildModel } from './model.js';
import { ZERO_CHAT_PROMPT } from './persona.js';
import { grep, list_dir, read_file } from './tools.js';
import { getJobState, runJob } from './worker.js';

// Zero's two tools. He has NO filesystem/shell access himself — only the worker does. This is
// the structural "plan-mode" boundary: the chat layer can dispatch and inspect, never mutate.

const dispatch_job = tool(
  async ({ task }) => {
    const job = createJob(task);
    // Fire-and-forget: the worker runs in the background, the chat turn returns immediately.
    void runJob(job.id, task);
    return `Started ${job.id}: "${task}". It's running in the background; use check_job to see progress.`;
  },
  {
    name: 'dispatch_job',
    description:
      'Hand a unit of real work (filesystem/shell/build/test) to the background worker. Returns immediately with a job id while the worker runs.',
    schema: z.object({
      task: z.string().describe('A clear, self-contained description of the work to do.'),
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
    // job tools for mutating work. No write/shell here — that's the worker's job.
    tools: [read_file, list_dir, grep, dispatch_job, check_job],
    systemPrompt: ZERO_CHAT_PROMPT,
    checkpointer: new MemorySaver(),
  });
}

export const getGraph = () => (graph ??= build());
