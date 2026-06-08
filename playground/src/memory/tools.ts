import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getIdentity, type Visibility } from './identity.js';
import { forgetFact, recall, remember, type StoredFact, updateFact } from './semantic.js';

/**
 * Zero's self-managed memory tools. They read the active identity from the run config (set by the
 * conductor / Slack adapter), so a fact scopes to who/what it's ABOUT and recalls by who's PRESENT —
 * never by the channel/thread id. Chat-layer only in v1 (subprocess workers reach memory via MCP later).
 */

const fmt = (f: StoredFact): string =>
  `- (${f.subject_scope}${f.kind === 'personal' ? ', personal' : ''}) ${f.fact}`;

export const remember_tool = tool(
  async ({ fact, about, visibility, personal }, config) => {
    const id = getIdentity(config);
    const subjectScope = about ?? id.speaker;
    const res = await remember({
      fact,
      subjectScope,
      id,
      visibility: visibility as Visibility | undefined,
      kind: personal ? 'personal' : 'work',
    });
    const verb = res.action === 'updated' ? 'Updated what I knew' : 'Got it — remembered that';
    return `${verb} (about ${subjectScope}).`;
  },
  {
    name: 'remember',
    description:
      "Save a durable fact worth recalling in later conversations — a preference, a decision, a detail about a person or the company. Scope it to who/what it's ABOUT; the fact then follows that entity across every surface (DMs, channels, group chats).",
    schema: z.object({
      fact: z
        .string()
        .describe('The fact stated plainly, e.g. "Dennis prefers TypeScript over JavaScript".'),
      about: z
        .string()
        .optional()
        .describe(
          'Subject scope it is about: person:<id>, team:<id>, company:<id>, or global. Defaults to the person you are talking with.',
        ),
      visibility: z
        .enum(['private', 'company'])
        .optional()
        .describe(
          "Who may surface it. 'private' (default for person facts) stays in 1:1s with that person; 'company' is shareable in any conversation.",
        ),
      personal: z.boolean().optional().describe('True for a personal (non-work) detail.'),
    }),
  },
);

export const recall_tool = tool(
  async ({ query }, config) => {
    const id = getIdentity(config);
    const facts = await recall(query, id);
    if (facts.length === 0) return 'Nothing saved that matches.';
    return `What I know that's relevant:\n${facts.map(fmt).join('\n')}`;
  },
  {
    name: 'recall',
    description:
      'Look up what you already know that is relevant to the current moment — about the people present, the team, or the company. Use it to ground yourself before answering when prior context would help.',
    schema: z.object({
      query: z.string().describe('What you want to remember about, in natural language.'),
    }),
  },
);

export const update_memory_tool = tool(
  async ({ query, newFact }, config) => {
    const updated = await updateFact(query, newFact, getIdentity(config));
    return updated
      ? `Updated it (about ${updated.subject_scope}).`
      : 'No matching memory to update.';
  },
  {
    name: 'update_memory',
    description:
      'Correct or replace an existing fact when something changes (e.g. a preference or role changed). Finds the closest saved fact by meaning and overwrites it.',
    schema: z.object({
      query: z.string().describe('Roughly what the existing fact is about.'),
      newFact: z.string().describe('The corrected fact.'),
    }),
  },
);

export const forget_tool = tool(
  async ({ query }, config) => {
    const gone = await forgetFact(query, getIdentity(config));
    return gone ? `Forgot it (about ${gone.subject_scope}).` : 'No matching memory to forget.';
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
