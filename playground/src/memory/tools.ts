import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getIdentity, type Tier } from './identity.js';
import { forgetFact, recall, remember, type StoredFact, updateFact } from './semantic.js';

/**
 * Zero's self-managed memory tools. Identity (which bot, which project, who's present) is read from the
 * run config set by the conductor, so `remember` resolves the chosen tier to a concrete scope.
 */

const fmt = (f: StoredFact): string => `- ${f.fact}`;

export const remember_tool = tool(
  async ({ fact, tier }, config) => {
    const id = getIdentity(config);
    const t = (tier ?? 'company') as Tier;
    const res = await remember({ fact, tier: t, id });
    return `${res.action === 'updated' ? 'Updated what I knew' : 'Remembered'} (${t}).`;
  },
  {
    name: 'remember',
    description:
      'Save a durable fact worth recalling in later conversations — a decision, a preference, a work detail. Pick who should know it.',
    schema: z.object({
      fact: z
        .string()
        .describe('The fact, stated plainly, e.g. "We are standardizing on Postgres for all services".'),
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
