import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { z } from 'zod';
import { buildExtractModel } from '../model.js';
import { type Bot, ROSTER, rosterSummary } from '../roster.js';
import { type Identity } from './identity.js';
import { remember } from './semantic.js';
import { addTask, openTasks, type Task } from './tasks.js';

/**
 * The post-turn REFLECT pass — the "intentional memory" node. After a bot's turn, one cheap Haiku call
 * looks at what just happened and decides BOTH:
 *   - durable FACTS to remember (the old memory gate's job — stable preferences/decisions/roles), and
 *   - open TASKS/handoffs to track (the gap the old gate dropped — "you'll add the tracking hooks once
 *     the API's up" never got saved because the gate explicitly skipped task instructions).
 * Built as the project's `RunnableSequence + withStructuredOutput` chain (same shape as gate.ts). Facts
 * keep the old extraction rules verbatim so quality doesn't regress; tasks are the new half.
 */
export interface ReflectResult {
  reasoning: string;
  facts: { fact: string; tier: 'company' | 'bot' | 'private'; authorId: string }[];
  tasks: { description: string; assignee?: string }[];
}

namespace ReflectPass {
  interface Input {
    botName: string;
    botRole: string;
    roster: string;
    /** "Dennis=dennis, Alex=alex, James=james" — so the model emits ids, not display names. */
    people: string;
    /** The open tasks already tracked (so it won't re-propose one). */
    openTasks: string;
    /** This turn's exchange, "Name: text" per line. */
    transcript: string;
  }

  const Schema = z.object({
    reasoning: z.string().describe('one short sentence on what (if anything) is worth keeping'),
    facts: z
      .array(
        z.object({
          fact: z.string().describe('the durable fact, in plain words'),
          tier: z.enum(['company', 'bot', 'private']),
          authorId: z.string().describe('the id of the HUMAN who asserted it (e.g. "dennis")'),
        }),
      )
      .describe('durable facts worth remembering long-term; [] if none'),
    tasks: z
      .array(
        z.object({
          description: z.string().describe('the concrete thing that needs doing'),
          assignee: z
            .string()
            .optional()
            .describe('id of who should do it (e.g. "alex"), if clear'),
        }),
      )
      .describe(
        'NEW open tasks/handoffs raised this turn that are not already tracked; [] if none',
      ),
  });

  const PROMPT = `You are {botName}, the team's {botRole}, quietly reflecting AFTER a turn in the #dev
channel. Team: {roster}. People and their ids: {people}.

Look at what just happened and extract TWO things (be conservative — most turns yield little or nothing):

1) FACTS — durable things worth remembering long-term: a stable preference, a decision, a role, or a
   company fact. Extract ONLY from what the HUMANS said (not teammates' replies). Do NOT extract chatter,
   greetings, questions, task instructions, or coding-style/conventions (those aren't durable facts).
   For each, set "tier": company (default for work facts and the boss's preferences), private (personal
   or sensitive — keep to a 1:1), or bot (only relevant to you); and "authorId" = the human who said it.

2) TASKS — concrete open work or handoffs raised this turn that someone needs to follow up on: "you'll
   wire the hooks once the API's up", "I'll send you the spec", "we should add X". Set "assignee" to the
   id of whoever should do it, when it's clear. These are the commitments that get lost in the scrollback.

Already-tracked open tasks (do NOT repeat these):
{openTasks}

This turn:
{transcript}

Return facts:[] and tasks:[] when there's nothing worth saving.`;

  let chain: ReturnType<typeof build> | undefined;
  export const get = () => (chain ??= build());

  const build = () =>
    RunnableSequence.from<Input, ReflectResult>([
      new PromptTemplate<Input>({
        template: PROMPT,
        inputVariables: ['botName', 'botRole', 'roster', 'people', 'openTasks', 'transcript'],
      }),
      buildExtractModel().withStructuredOutput(Schema, { name: 'reflect' }),
    ]).withConfig({ runName: 'Reflect' });
}

const titleCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "Dennis=dennis, Alex=alex, James=james" from the present humans + the bot roster. */
function peopleHint(id: Identity): string {
  const humans = id.participants.map((h) => `${titleCase(h)}=${h}`);
  const bots = ROSTER.map((b) => `${b.name}=${b.id}`);
  return [...new Set([...humans, ...bots])].join(', ');
}

const formatOpenTasks = (tasks: Task[]): string =>
  tasks.length
    ? tasks.map((t) => `- ${t.description}${t.assignee ? ` (→ ${t.assignee})` : ''}`).join('\n')
    : '(none)';

/**
 * Run the reflect pass for one bot over this turn's transcript and persist what it finds. Facts are saved
 * with a PER-FACT identity (speaker = the asserting human) so private/pair scoping and `asserted_by` stay
 * correct on multi-speaker turns; tasks are company-scoped. Fire-and-forget — every error is swallowed so
 * reflection can never affect the channel.
 */
export async function reflect(bot: Bot, transcript: string, baseIdentity: Identity): Promise<void> {
  try {
    const result = await ReflectPass.get().invoke({
      botName: bot.name,
      botRole: bot.role,
      roster: rosterSummary(),
      people: peopleHint(baseIdentity),
      openTasks: formatOpenTasks(openTasks(baseIdentity.company)),
      transcript,
    });

    // Debug only (stderr, never the UI): show what this turn's reflect captured, so you can WATCH it work
    // on natural conversation — no need to prompt the bots. Mirrors the gate's stderr line.
    if (result.facts.length || result.tasks.length) {
      const f = result.facts.map((x) => x.fact).join(' | ') || '—';
      const t =
        result.tasks.map((x) => `${x.description}${x.assignee ? ` → ${x.assignee}` : ''}`).join(' | ') ||
        '—';
      process.stderr.write(`[reflect:${bot.name}] facts: [${f}]  tasks: [${t}]\n`);
    }

    for (const f of result.facts) {
      if (!f.fact?.trim()) continue;
      const speaker = (f.authorId || baseIdentity.speaker).toLowerCase();
      await remember({ fact: f.fact, tier: f.tier, id: { ...baseIdentity, speaker } });
    }
    for (const t of result.tasks) {
      if (!t.description?.trim()) continue;
      addTask({
        company: baseIdentity.company,
        description: t.description,
        assignee: t.assignee ? t.assignee.toLowerCase() : undefined,
        createdBy: bot.id,
        source: baseIdentity.surface,
      });
    }
  } catch {
    /* fire-and-forget: reflection must never break the channel */
  }
}
