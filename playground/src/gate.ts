import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableLambda, RunnableSequence } from '@langchain/core/runnables';
import { z } from 'zod';
import { buildGateModel } from './model.js';
import { addressedBots, type Bot, mentionedBots, rosterSummary } from './roster.js';

/** The three-tier response gate: reply, react ("got it" without noise), or stay silent. */
export interface GateDecision {
  action: 'respond' | 'acknowledge' | 'ignore';
  /** The reaction emoji, when action is 'acknowledge'. */
  emoji?: string;
}

const RESPOND: GateDecision = { action: 'respond' };
const IGNORE: GateDecision = { action: 'ignore' };

/**
 * The soft gate, as a few-shot classification chain (the project's `RunnableSequence.from` pattern):
 * input formatter → prompt (with worked examples) → Haiku with a structured `{action, emoji}` tool call →
 * output formatter. The examples are where the real work happens: they teach the model to READ THE ROOM —
 * to stay out of a back-and-forth that's clearly between the human and another teammate, and to never
 * speak up just to defer, agree, or volunteer. The conversation history is the signal that makes that
 * judgment possible, so the caller passes a generous window.
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

  interface Example {
    you: string;
    history: string;
    author: string;
    text: string;
    decision: DecisionT;
  }

  // Worked examples — the heart of the gate. Each shows a snippet of conversation, the next message, who
  // YOU are, and the right call. They cover the failure modes we actually saw (a teammate popping into a
  // solo human↔teammate thread, replying just to defer, replying to a thanks/dismissal) plus the genuine
  // reasons to speak (addressed to you, your lane, an open team question, a real handoff, an FYI).
  const EXAMPLES: Example[] = [
    {
      you: 'James (marketing & analytics)',
      history:
        "Dennis: Alex, let's start planning our NestJS backend. How should we structure it?\nAlex: Good question — I'd start by mapping the core modules and the data layer.",
      author: 'Dennis',
      text: 'Do you have access to that?',
      decision: {
        reasoning:
          'This is an ongoing back-and-forth between Dennis and Alex about the backend — not mine.',
        action: 'ignore',
      },
    },
    {
      you: 'James (marketing & analytics)',
      history:
        'Dennis: Alex, can you look at how the UI loads history on startup?\nAlex: On it — digging into the checkpoint loading now.',
      author: 'Alex',
      text: "I think the history persists but the UI never replays it on boot. I'll write up a fix.",
      decision: {
        reasoning:
          "Alex is thinking out loud on his own task; I have nothing to add and shouldn't chime in to say it's his area.",
        action: 'ignore',
      },
    },
    {
      you: 'James (marketing & analytics)',
      history:
        "Dennis: Alex, let's take the backend planning from here.\nAlex: Sounds good, I'll scope it out.",
      author: 'Dennis',
      text: "Thanks James, we'll take it from here.",
      decision: {
        reasoning: 'A thanks / dismissal aimed at me — nothing to do but step back.',
        action: 'ignore',
      },
    },
    {
      you: 'Alex (backend engineer)',
      history: 'Dennis: Morning team — standup time.',
      author: 'Dennis',
      text: "What's the single most important thing each of us should focus on today?",
      decision: {
        reasoning: 'An open question to the whole team — I should give my own backend priority.',
        action: 'respond',
      },
    },
    {
      you: 'James (marketing & analytics)',
      history: 'Alex: Pushed the new analytics endpoint to staging.',
      author: 'Dennis',
      text: 'James, can you pull last week’s funnel numbers and see where we’re losing people?',
      decision: { reasoning: 'Directly asked of me and squarely in my lane.', action: 'respond' },
    },
    {
      you: 'James (marketing & analytics)',
      history: 'Dennis: Standup done, thanks both.',
      author: 'Alex',
      text: '@James the tracking API is live now — you can start wiring the funnel events whenever.',
      decision: {
        reasoning: 'A real handoff to me — a concrete task I can pick up.',
        action: 'respond',
      },
    },
    {
      you: 'Alex (backend engineer)',
      history: 'Dennis: Pushing a config change.',
      author: 'Dennis',
      text: 'FYI — the staging deploy just went green. No action needed.',
      decision: {
        reasoning: 'An FYI to everyone that asks nothing — a reaction is enough.',
        action: 'acknowledge',
        emoji: '✅',
      },
    },
  ];

  const formatExample = (e: Example): string =>
    `[you are ${e.you}]\n${e.history}\n↳ new message from ${e.author}: "${e.text}"\n→ ${JSON.stringify(
      e.decision,
    )}`;

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
  dismissal, or small talk not aimed at you. NEVER speak up just to defer ("that's Alex's area"), to
  agree, to encourage, to volunteer for later, or to be polite — staying silent IS the right move; the
  teammate it belongs to will pick it up on their own.

Worked examples (different "you" in each):
{examples}`;

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
        partialVariables: { examples: EXAMPLES.map(formatExample).join('\n\n') },
      }),
      buildGateModel().withStructuredOutput(Decision, { name: 'gate_decision' }),
      RunnableLambda.from<DecisionT, GateDecision>((d) =>
        d.action === 'acknowledge'
          ? { action: 'acknowledge', emoji: cleanEmoji(d.emoji) }
          : { action: d.action },
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
  bot: Bot,
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
