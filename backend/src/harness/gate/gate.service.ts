import { type AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  Runnable,
  type RunnableConfig,
  RunnableLambda,
  RunnableSequence,
} from '@langchain/core/runnables';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { EmployeeRegistry } from '../employees/employee.registry';
import type { EmployeeDefinition } from '../employees/employee.types';
import { TEAM_RULES } from '../employees/persona.prompts';
import { ChatModelFactory } from '../llm/chat-model.factory';
import { GATE_PROMPT } from './gate.prompts';

/** The three-tier response gate: reply, react ("got it" without noise), or stay silent. */
export interface GateDecision {
  action: 'respond' | 'acknowledge' | 'ignore';
  /** The reaction emoji, when action is 'acknowledge'. */
  emoji?: string;
  /** Debug only: the soft gate's one-line rationale. Absent for hard-rule decisions. */
  reasoning?: string;
  /** Debug only: exact token usage for this gate call (from the API). Absent for hard-rule decisions. */
  usage?: { input: number; output: number };
  /** True when the soft (LLM) gate actually ran — drives the dormancy counter (only soft ignores
   * push a bot toward dormancy). Absent/false for every hard-rule and dormant-skip decision. */
  softGate?: boolean;
  /** True when a DORMANT bot cheap-ignored an off-lane message (no wake trigger) — no LLM call.
   * The gate node routes this to `mark_seen → END`, skipping the reconcile pass too. */
  dormantSkip?: boolean;
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
      // Render the prompt to a single HumanMessage — the same role the prior PromptTemplate's
      // StringPromptValue produced. TEAM_RULES is spliced into its slot here (static).
      RunnableLambda.from<GateInput, HumanMessage[]>((v) => [
        new HumanMessage(GATE_PROMPT({ ...v, teamRules: TEAM_RULES })),
      ]),
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
          return { ...base, reasoning: parsed.reasoning, usage, softGate: true };
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
      /** DORMANCY: when true, this bot has gone dormant in the room (K consecutive soft ignores).
       * An off-lane message with no wake trigger (its name/@/broadcast already short-circuit to
       * respond above; a bare-name hail or a lane keyword still wakes it) is cheap-ignored without
       * the soft LLM call. */
      dormant?: boolean;
    } = {},
    /** Forwarded to the soft chain so its LLM call nests under the turn's Langfuse trace. */
    config?: RunnableConfig,
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

    // DORMANCY: a dormant bot only earns the soft gate when something hails it — a bare-name/@
    // mention of itself (meAddressed; @handle already returned respond above) or a lane keyword
    // anywhere in the batch. An off-lane message is a free ignore (no LLM; the graph also skips
    // reconcile via dormantSkip). When not dormant, behaves exactly as before.
    if (opts.dormant && !meAddressed) {
      const batchText = batch.map((m) => m.text).join('\n');
      if (!this.employees.keywordHit(bot, batchText))
        return { action: 'ignore', dormantSkip: true };
    }

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
      }, config);
    } catch {
      return IGNORE; // a gate failure must never crash the channel — default to quiet
    }
  }
}
