import type { AIMessage } from '@langchain/core/messages';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableLambda, RunnableSequence } from '@langchain/core/runnables';
import { z } from 'zod';
import { addressedBots, type Employee, mentionedBots, rosterSummary } from './employees/index.js';
import { buildGateModel } from './model.js';

/** The three-tier response gate: reply, react ("got it" without noise), or stay silent. */
export interface GateDecision {
  action: 'respond' | 'acknowledge' | 'ignore';
  /** The reaction emoji, when action is 'acknowledge'. */
  emoji?: string;
  /** Debug only: the soft gate's one-line rationale. Absent for hard-rule decisions. */
  reasoning?: string;
  /** Debug only: exact token usage for this gate call (from the API). Absent for hard-rule decisions. */
  usage?: { input: number; output: number };
}

const RESPOND: GateDecision = { action: 'respond' };
const IGNORE: GateDecision = { action: 'ignore' };

/**
 * The soft gate, as a zero-shot classification chain (the project's `RunnableSequence.from` pattern):
 * input formatter → prompt → Haiku with a structured `{reasoning, action, emoji}` tool call → output
 * formatter. The instructions carry the whole judgment — READ THE ROOM: stay out of a back-and-forth
 * clearly between the human and another teammate, and never speak up just to defer, agree, or volunteer.
 * The conversation history is the signal that makes that judgment possible, so the caller passes a
 * generous window.
 *
 * NOTE: we dropped the few-shot worked examples. They reused the real teammates' names (Alex/James/
 * Dennis), and on Haiku that bled into the model's self-identity — it would reason "as James" while
 * gating FOR Alex. Identity now comes only from `{botName}`/`{botRole}` at the top, with no competing
 * "you are <someone else>" lines below it. Re-add examples only with neutral, non-roster names.
 */
namespace ResponseGate {
  export interface Input {
    botName: string;
    botRole: string;
    roster: string;
    /** The conversation BEFORE the message under judgment ("Name: text" per line, oldest first). */
    history: string;
    /** Who sent the message under judgment. */
    author: string;
    /** True when the author is another bot (teammate) rather than a human. */
    fromTeammate: boolean;
    /** The message under judgment. */
    text: string;
  }

  interface PromptInput extends Input {
    teammateNote: string;
  }

  const Decision = z.object({
    reasoning: z
      .string()
      .describe('one short sentence — whose conversation is this, and is it yours to answer?'),
    action: z.enum(['respond', 'acknowledge', 'ignore']),
    emoji: z.string().optional().describe('a single emoji — ONLY when action is "acknowledge"'),
  });
  type DecisionT = z.infer<typeof Decision>;

  const PROMPT = `You are {botName}, the {botRole} on a small team, in the shared #dev channel.
Team: {roster}.

You share this channel with teammates and the boss. You are ONE of several people who could reply — the
others can answer too. Decide ONLY whether YOU should speak up about the latest message, given the
conversation so far. Read the room.

Conversation so far (oldest first):
{history}

Latest message — from {author}{teammateNote}:
"{text}"

Pick one action:
- "respond": it's genuinely yours — addressed to you, squarely in your lane ({botRole}), or an open
  question to the whole team you can add real substance to.
- "acknowledge": an FYI/announcement to everyone that asks nothing — a single emoji, no words.
- "ignore": NOT yours. This is the default when unsure. IGNORE when the latest message continues a
  back-and-forth between {author} and another teammate, sits in someone else's lane, or is a thanks,
  dismissal, or small talk not aimed at you. NEVER speak up just to defer ("that's their area"), to
  agree, to encourage, to volunteer for later, or to be polite — staying silent IS the right move; the
  teammate it belongs to will pick it up on their own.`;

  let chain: ReturnType<typeof build> | undefined;
  export const get = () => (chain ??= build());

  const build = () =>
    RunnableSequence.from<Input, GateDecision>([
      RunnableLambda.from<Input, PromptInput>((input) => ({
        ...input,
        teammateNote: input.fromTeammate ? ' (a teammate)' : ' (the boss)',
      })),
      new PromptTemplate<PromptInput>({
        template: PROMPT,
        inputVariables: [
          'botName',
          'botRole',
          'roster',
          'history',
          'author',
          'teammateNote',
          'text',
        ],
      }),
      // includeRaw keeps the raw AIMessage so we can read its usage_metadata (exact token counts).
      // Plain withStructuredOutput returns only the parsed object and would drop the usage.
      buildGateModel().withStructuredOutput(Decision, { name: 'gate_decision', includeRaw: true }),
      RunnableLambda.from<{ raw: AIMessage; parsed: DecisionT }, GateDecision>(
        ({ raw, parsed }) => {
          const u = raw.usage_metadata;
          const usage = u ? { input: u.input_tokens, output: u.output_tokens } : undefined;
          const base =
            parsed.action === 'acknowledge'
              ? { action: 'acknowledge' as const, emoji: cleanEmoji(parsed.emoji) }
              : { action: parsed.action };
          return { ...base, reasoning: parsed.reasoning, usage };
        },
      ),
    ]).withConfig({ runName: 'Response Gate' });

  const cleanEmoji = (e?: string): string => {
    const s = (e ?? '').trim();
    return s && s.length <= 8 ? s : '👍';
  };
}

/**
 * Decide how `bot` should handle the latest channel message. Deterministic hard rules first (they save a
 * model call and are unambiguous), then the few-shot soft gate for everything nuanced:
 *  - your own message → ignore;
 *  - an explicit `@you` from a human → respond (a direct hail);
 *  - someone ELSE named/@'d (not you) → ignore (it's their thread);
 *  - otherwise (no names, or your BARE name — which might be a thanks/dismissal) → the soft chain reads
 *    the conversation and decides respond / acknowledge / ignore.
 */
export async function gate(
  bot: Employee,
  text: string,
  opts: { authorBotId?: string; authorName?: string; history?: string } = {},
): Promise<GateDecision> {
  if (opts.authorBotId === bot.id) return IGNORE; // never react to your own message

  const fromBot = !!opts.authorBotId;
  const mentioned = mentionedBots(text); // explicit @handles only
  const addressed = addressedBots(text); // @handles OR bare names
  const meMentioned = mentioned.some((b) => b.id === bot.id);
  const meAddressed = addressed.some((b) => b.id === bot.id);

  if (!fromBot && meMentioned) return RESPOND; // a human @'d you by name — a direct hail
  if (addressed.length > 0 && !meAddressed) return IGNORE; // named/@'d someone else, not you → their thread

  try {
    return await ResponseGate.get().invoke({
      botName: bot.name,
      botRole: bot.role,
      roster: rosterSummary(),
      history: opts.history ?? '(no earlier messages)',
      author: opts.authorName ?? (fromBot ? 'a teammate' : 'the boss'),
      fromTeammate: fromBot,
      text,
    });
  } catch {
    return IGNORE; // a gate failure must never crash the channel — default to quiet
  }
}
