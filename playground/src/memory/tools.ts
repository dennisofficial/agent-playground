import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { botById } from '../employees/index.js';
import { rememberDeduped } from './dedup.js';
import { getIdentity, type Tier } from './identity.js';
import { forgetFact, recall, type StoredFact, updateFact } from './semantic.js';
import { addTask, completeTask, getTask, listTasks, type Task } from './tasks.js';

/**
 * Zero's self-managed memory tools. Identity (which bot, which project, who's present) is read from the
 * run config set by the conductor, so `remember` resolves the chosen tier to a concrete scope.
 */

const fmt = (f: StoredFact): string => `- ${f.fact}`;

export const remember_tool = tool(
  async ({ fact, tier }, config) => {
    const id = getIdentity(config);
    const t = (tier ?? 'project') as Tier;
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
        .enum(['team', 'project', 'bot', 'private'])
        .optional()
        .describe(
          "Who should know it: 'project' (default — a fact about THIS project: its repo, stack, goals, or a decision), 'team' (roles, who does what, the boss's standing preferences — shared across every project), 'bot' (just you, across all your chats), or 'private' (1:1 with this person — personal or sensitive).",
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
      'Look up what you already know that is relevant right now — this project, team knowledge, your own notes, or (in a 1:1) what you know about this person. Use it to ground yourself before answering.',
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

// ── Personal reminders (the "plate") ─────────────────────────────────────────────────────────────────
// Per-employee reminders so a commitment in passing isn't forgotten in a long session. The reflect pass
// captures these automatically; these tools let a bot read its plate and close things out. A teammate
// sees only their own plate; the SCRUM MASTER sees everyone's (gated here, not in the table). Distinct
// from the shared Jira board (board/tools.ts) — reminders are the lightweight personal layer.

const fmtTask = (t: Task): string => `- [#${t.id}] ${t.description} (→ ${t.owner})`;

export const list_tasks_tool = tool(
  async ({ scope }, config) => {
    const id = getIdentity(config);
    const isScrumMaster = !!botById(id.selfAgent)?.scrumMaster;
    // 'team' (all plates) is scrum-master only; everyone else always sees just their own plate.
    const owner = scope === 'team' && isScrumMaster ? undefined : id.selfAgent;
    const tasks = listTasks({ project: id.project, status: 'open', owner });
    if (tasks.length === 0)
      return owner ? 'Nothing open on your plate.' : 'No open reminders across the team.';
    return `${owner ? 'On your plate' : "Everyone's plates"}:\n${tasks.map(fmtTask).join('\n')}`;
  },
  {
    name: 'list_tasks',
    description:
      "Your open reminders — the things you committed to do but haven't yet. Use it when picking up work or when someone asks what's on your plate. (Scrum master only: 'team' to see everyone's plates.)",
    schema: z.object({
      scope: z
        .enum(['mine', 'team'])
        .optional()
        .describe(
          "'mine' (default) for your own plate; 'team' for everyone's — scrum master only, ignored for everyone else.",
        ),
    }),
  },
);

export const add_task_tool = tool(
  async ({ description, owner }, config) => {
    const id = getIdentity(config);
    const onPlate = owner?.trim().toLowerCase() || id.selfAgent; // default: your own plate
    const t = addTask({
      project: id.project,
      description,
      owner: onPlate,
      createdBy: id.selfAgent,
    });
    if (!t) return "That's already on the plate — left it as is.";
    return onPlate === id.selfAgent
      ? `Added reminder #${t.id}.`
      : `Added reminder #${t.id} for ${onPlate}.`;
  },
  {
    name: 'add_task',
    description:
      "Log a reminder explicitly — a concrete thing to do later. Defaults to your own plate; pass a teammate's id to hand it to them. Most reminders get captured automatically; use this to be sure one is tracked.",
    schema: z.object({
      description: z
        .string()
        .describe('The reminder, stated plainly, e.g. "Wire funnel events into the API".'),
      owner: z
        .string()
        .optional()
        .describe("Whose plate it goes on (a teammate's id like 'alex'); omit for your own."),
    }),
  },
);

export const complete_task_tool = tool(
  async ({ id: taskId }, config) => {
    const id = getIdentity(config);
    const task = getTask(id.project, taskId);
    if (!task || task.status !== 'open') return `No open reminder #${taskId} found.`;
    // Authority: only the plate's owner, or the scrum master, may close it.
    if (task.owner !== id.selfAgent && !botById(id.selfAgent)?.scrumMaster)
      return `Reminder #${taskId} is on ${task.owner}'s plate — only they or the scrum master can close it.`;
    completeTask(id.project, taskId);
    return task.owner === id.selfAgent
      ? `Marked reminder #${taskId} done.`
      : `Cleared reminder #${taskId} off ${task.owner}'s plate.`;
  },
  {
    name: 'complete_task',
    description:
      "Mark a reminder done once it's actually finished — pass the reminder id (the #N from list_tasks). Normally one of your own; as scrum master you can also clear a stale or misassigned reminder off any teammate's plate.",
    schema: z.object({
      id: z.number().describe('The reminder id to complete (the #N from list_tasks).'),
    }),
  },
);

export const taskTools = [list_tasks_tool, add_task_tool, complete_task_tool];
