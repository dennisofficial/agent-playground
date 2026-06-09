import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { rememberDeduped } from './dedup.js';
import { getIdentity, type Tier } from './identity.js';
import { forgetFact, recall, type StoredFact, updateFact } from './semantic.js';
import { addTask, completeTask, listTasks, type Task } from './tasks.js';

/**
 * Zero's self-managed memory tools. Identity (which bot, which project, who's present) is read from the
 * run config set by the conductor, so `remember` resolves the chosen tier to a concrete scope.
 */

const fmt = (f: StoredFact): string => `- ${f.fact}`;

export const remember_tool = tool(
  async ({ fact, tier }, config) => {
    const id = getIdentity(config);
    const t = (tier ?? 'company') as Tier;
    const res = await rememberDeduped({ fact, tier: t, id });
    return `${res.action === 'updated' ? 'Updated what I knew' : 'Remembered'} (${t}).`;
  },
  {
    name: 'remember',
    description:
      'Save a durable fact worth recalling in later conversations — a decision, a preference, a work detail. Pick who should know it.',
    schema: z.object({
      fact: z
        .string()
        .describe(
          'The fact, stated plainly, e.g. "We are standardizing on Postgres for all services".',
        ),
      tier: z
        .enum(['company', 'bot', 'private'])
        .optional()
        .describe(
          "Who should know it: 'company' (default — all bots in the workspace), 'bot' (just you, across all your chats), or 'private' (1:1 with this person — use for personal or sensitive things).",
        ),
    }),
  },
);

export const recall_tool = tool(
  async ({ query }, config) => {
    const facts = await recall(query, getIdentity(config));
    if (facts.length === 0) return 'Nothing saved that matches.';
    return `What I know that's relevant:\n${facts.map(fmt).join('\n')}`;
  },
  {
    name: 'recall',
    description:
      'Look up what you already know that is relevant right now — company knowledge, your own notes, or (in a 1:1) what you know about this person. Use it to ground yourself before answering.',
    schema: z.object({
      query: z.string().describe('What you want to remember about, in natural language.'),
    }),
  },
);

export const update_memory_tool = tool(
  async ({ query, newFact }, config) => {
    const updated = await updateFact(query, newFact, getIdentity(config));
    return updated ? 'Updated it.' : 'No matching memory to update.';
  },
  {
    name: 'update_memory',
    description:
      'Correct or replace an existing fact when something changes. Finds the closest saved fact by meaning and overwrites it.',
    schema: z.object({
      query: z.string().describe('Roughly what the existing fact is about.'),
      newFact: z.string().describe('The corrected fact.'),
    }),
  },
);

export const forget_tool = tool(
  async ({ query }, config) => {
    const gone = await forgetFact(query, getIdentity(config));
    return gone ? 'Forgot it.' : 'No matching memory to forget.';
  },
  {
    name: 'forget',
    description:
      'Forget a saved fact (soft-deleted, not destroyed). Use when something is no longer true or should not be kept.',
    schema: z.object({
      query: z.string().describe('Roughly what the fact to forget is about.'),
    }),
  },
);

export const memoryTools = [remember_tool, recall_tool, update_memory_tool, forget_tool];

// ── The internal task board ──────────────────────────────────────────────────────────────────────────
// Open handoffs/todos shared across the team. The reflect pass captures these automatically after a turn;
// these tools let a bot read what's open and close things out. Company scope comes from the run identity.

const fmtTask = (t: Task): string =>
  `- [#${t.id}] ${t.description}${t.assignee ? ` (→ ${t.assignee})` : ''}`;

export const list_tasks_tool = tool(
  async ({ scope }, config) => {
    const id = getIdentity(config);
    const tasks = listTasks({
      company: id.company,
      status: 'open',
      assignee: scope === 'mine' ? id.selfAgent : undefined,
    });
    if (tasks.length === 0)
      return scope === 'mine' ? 'Nothing open on your plate.' : 'No open tasks for the team.';
    return `Open tasks:\n${tasks.map(fmtTask).join('\n')}`;
  },
  {
    name: 'list_tasks',
    description:
      "The team's open tasks/handoffs (the internal task board). Use it to see what still needs doing — yours or everyone's — e.g. when picking up work or someone asks what's outstanding.",
    schema: z.object({
      scope: z
        .enum(['mine', 'team'])
        .optional()
        .describe("'mine' for tasks assigned to you, 'team' (default) for all open tasks."),
    }),
  },
);

export const add_task_tool = tool(
  async ({ description, assignee }, config) => {
    const id = getIdentity(config);
    const t = addTask({
      company: id.company,
      description,
      assignee: assignee?.toLowerCase(),
      createdBy: id.selfAgent,
    });
    return t ? `Added task #${t.id}.` : "That's already on the board — left it as is.";
  },
  {
    name: 'add_task',
    description:
      "Add an open task/handoff to the team's board — a concrete thing that needs doing later (e.g. a handoff to a teammate). Most get captured automatically; use this to log one explicitly.",
    schema: z.object({
      description: z
        .string()
        .describe('The task, stated plainly, e.g. "Wire funnel events into the API".'),
      assignee: z
        .string()
        .optional()
        .describe("Who should do it (a teammate's id like 'alex'), if it's clear."),
    }),
  },
);

export const complete_task_tool = tool(
  async ({ id: taskId }, config) => {
    const id = getIdentity(config);
    const ok = completeTask(id.company, taskId);
    return ok ? `Marked task #${taskId} done.` : `No open task #${taskId} found.`;
  },
  {
    name: 'complete_task',
    description:
      "Mark a task on the board done once it's actually finished. Pass the task id (from list_tasks).",
    schema: z.object({
      id: z.number().describe('The task id to complete (the #N from list_tasks).'),
    }),
  },
);

export const taskTools = [list_tasks_tool, add_task_tool, complete_task_tool];
