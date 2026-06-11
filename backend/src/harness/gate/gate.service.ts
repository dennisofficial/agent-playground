import type { AIMessage } from '@langchain/core/messages';
import { PromptTemplate } from '@langchain/core/prompts';
import {
  Runnable,
  RunnableLambda,
  RunnableSequence,
} from '@langchain/core/runnables';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { EmployeeRegistry } from '../employees/employee.registry';
import type { EmployeeDefinition } from '../employees/employee.types';
import { TEAM_RULES } from '../employees/persona.service';
import { ChatModelFactory } from '../llm/chat-model.factory';

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

/** The room a gated message lives in — drives hard rules (DM → always respond) + prompt context. */
export interface GateChannelContext {
  kind: 'channel' | 'dm' | 'group-dm';
  name: string;
}

interface GateInput {
  botName: string;
  botRole: string;
  roster: string;
  /** Where this conversation is happening ("the shared #project-a channel" / a group DM). */
  room: string;
  /** The conversation BEFORE the message under judgment ("Name: text" per line, oldest first). */
  history: string;
  /** Who sent the message under judgment. */
  author: string;
  teammateNote: string;
  /** The message under judgment. */
  text: string;
  /** Per-employee standing protocols, formatted as a bullet list (empty string when none). */
  protocols: string;
}

const Decision = z.object({
  reasoning: z
    .string()
    .describe(
      'one short sentence — whose conversation is this, and is it yours to answer?',
    ),
  action: z.enum(['respond', 'acknowledge', 'ignore']),
  emoji: z
    .string()
    .optional()
    .describe('a single emoji — ONLY when action is "acknowledge"'),
});
type DecisionT = z.infer<typeof Decision>;

// NOTE: no few-shot worked examples on purpose. They reused the real teammates' names, and on Haiku
// that bled into the model's self-identity — it would reason "as James" while gating FOR Alex.
// Identity comes only from {botName}/{botRole} at the top. Re-add examples only with neutral names.
const PROMPT = `You are {botName}, the {botRole} on a small team, in {room}.
Team: {roster}.

${TEAM_RULES}

{protocols}

You share this channel with teammates and the boss. You are ONE of several people who could reply — the
others can answer too. Decide ONLY whether YOU should speak up about the latest message, given the
conversation so far. Read the room.

Conversation so far (oldest first):
{history}

Latest message — from {author}{teammateNote}:
"{text}"

Pick one action. Each one triggers something different AFTER you choose it — so pick by what the message
needs from you, not just by tone:
- "respond": you take the floor — you read context, think, then ACT: you answer, or use your tools to
  actually DO the work being asked. This is the ONLY action that does real work; the other two just react
  or stay quiet. Pick it when the message is addressed to you, hands you a task or a go-ahead to start
  work in your lane ({botRole}), asks you a question, or is an open question to the whole team you can add
  real substance to. If it needs you to act or reply, it's respond.
- "acknowledge": you drop a single emoji and the turn ENDS right there — no words, no work, nothing else
  runs. ONLY for a message that needs nothing active from you: a pure FYI/announcement, or a note that
  just adjusts what's already on your plate (you've seen it — there's nothing to DO). If the message asks
  you to start, build, run, execute, ship, produce, or answer something, "acknowledge" would silently
  drop that on the floor — use "respond" instead.
- "ignore": NOT yours. This is the default when unsure. IGNORE when the latest message continues a
  back-and-forth between {author} and another teammate, sits in someone else's lane, or is a thanks,
  dismissal, or small talk not aimed at you. NEVER speak up just to defer ("that's their area"), to
  agree, to encourage, to volunteer for later, or to be polite — staying silent IS the right move; the
  teammate it belongs to will pick it up on their own.`;

const cleanEmoji = (e?: string): string => {
  const s = (e ?? '').trim();
  return s && s.length <= 8 ? s : '👍';
};

/**
 * Decide how a bot should handle the latest channel message. Deterministic hard rules first (they
 * save a model call and are unambiguous), then the soft Haiku gate for everything nuanced.
 * (Ported from playground/src/gate.ts.)
 */
@Injectable()
export class GateService {
  private chain?: Runnable<GateInput, GateDecision>;

  constructor(
    private readonly employees: EmployeeRegistry,
    private readonly models: ChatModelFactory,
  ) {}

  private soft() {
    return (this.chain ??= RunnableSequence.from<GateInput, GateDecision>([
      new PromptTemplate<GateInput>({
        template: PROMPT,
        inputVariables: [
          'botName',
          'botRole',
          'roster',
          'room',
          'history',
          'author',
          'teammateNote',
          'text',
          'protocols',
        ],
      }),
      // includeRaw keeps the raw AIMessage so we can read its usage_metadata (exact token counts).
      this.models.buildGateModel().withStructuredOutput(Decision, {
        name: 'gate_decision',
        includeRaw: true,
      }),
      RunnableLambda.from<{ raw: AIMessage; parsed: DecisionT }, GateDecision>(
        ({ raw, parsed }) => {
          const u = raw.usage_metadata;
          const usage = u
            ? { input: u.input_tokens, output: u.output_tokens }
            : undefined;
          const base =
            parsed.action === 'acknowledge'
              ? {
                  action: 'acknowledge' as const,
                  emoji: cleanEmoji(parsed.emoji),
                }
              : { action: parsed.action };
          return { ...base, reasoning: parsed.reasoning, usage };
        },
      ),
    ]).withConfig({ runName: 'Response Gate' }));
  }

  /**
   * Hard rules first:
   *  - your own message → ignore;
   *  - a 1:1 DM → respond (everything said there is addressed to you; an emoji-only acknowledge
   *    feels wrong 1:1, so the soft gate never runs);
   *  - an explicit `@you` or a broadcast (`@here`/`@channel`/`@everyone`) ANYWHERE in the
   *    unconsumed batch → respond. The batch matters: a busy bot consumes several messages in one
   *    turn, and a hail must not be swallowed because a teammate's reply landed after it;
   *  - someone ELSE named/@'d (not you) in the LATEST message, no broadcast → ignore (their thread);
   *  - otherwise → the soft chain reads the conversation and decides on the latest message.
   */
  async gate(
    bot: EmployeeDefinition,
    text: string,
    opts: {
      authorBotId?: string;
      authorName?: string;
      history?: string;
      channel?: GateChannelContext;
      /** The bot's full unconsumed batch (oldest first), when it consumed more than `text`. */
      batch?: { text: string; authorBotId?: string }[];
    } = {},
  ): Promise<GateDecision> {
    if (opts.authorBotId === bot.id) return IGNORE; // never react to your own message
    if (opts.channel?.kind === 'dm') return RESPOND; // a 1:1 is always yours to answer

    const fromBot = !!opts.authorBotId;
    const batch = (
      opts.batch?.length
        ? opts.batch
        : [{ text, authorBotId: opts.authorBotId }]
    ).filter((m) => m.authorBotId !== bot.id);
    const meMentioned = batch.some((m) =>
      this.employees.mentionedBots(m.text).some((b) => b.id === bot.id),
    ); // explicit @handles only
    const anyBroadcast = batch.some((m) => this.employees.isBroadcast(m.text));
    const addressed = this.employees.addressedBots(text); // @handles OR bare names — latest only
    const meAddressed = addressed.some((b) => b.id === bot.id);

    if (meMentioned) return RESPOND;
    if (anyBroadcast) return RESPOND;
    if (addressed.length > 0 && !meAddressed) return IGNORE;

    try {
      return await this.soft().invoke({
        botName: bot.name,
        botRole: bot.role,
        roster: this.employees.rosterSummary(),
        room:
          opts.channel?.kind === 'group-dm'
            ? `a small group DM ("${opts.channel.name}")`
            : `the shared #${opts.channel?.name ?? 'dev'} channel`,
        history: opts.history ?? '(no earlier messages)',
        author: opts.authorName ?? (fromBot ? 'a teammate' : 'the boss'),
        teammateNote: fromBot ? ' (a teammate)' : ' (the boss)',
        text,
        protocols: bot.protocols?.length
          ? `Your standing protocols:\n${bot.protocols.map((p) => `- ${p}`).join('\n')}`
          : '',
      });
    } catch {
      return IGNORE; // a gate failure must never crash the channel — default to quiet
    }
  }
}
