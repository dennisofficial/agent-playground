import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Injectable, Logger } from '@nestjs/common';
import { EmployeeRegistry } from '../employees/employee.registry';
import type { EmployeeDefinition } from '../employees/employee.types';
import { ChatModelFactory } from '../llm/chat-model.factory';

export type GateDecision = 'respond' | 'skip';

const GATE_SYSTEM = `You decide whether an AI assistant should REPLY to the latest message in a Slack channel, or stay quiet because the message is between people / not something for the assistant.
- The assistant is the team's orchestrator: it takes requests, answers questions, and runs the coding work (builds, checks, pipelines, tickets, PRs, deploys, migrations). It is the ONLY AI in the channel; everyone else is a person.
- RESPOND when the latest message asks the assistant to do or answer something, continues a thread the assistant is already in, or references work the assistant is running — EVEN when phrased as a status update or observation rather than a direct request. A status update about that work is an implicit cue to act on it (e.g. "the migration's done", "that check should pass now", "CI is green", "I fixed the env var, try again"). If acting on the message is plausibly useful, RESPOND.
- RESPOND when the latest message reacts to, corrects, contradicts, or follows up on something the assistant ITSELF just said in the recent context above — even a blunt correction ("no, that's wrong", "that's not X, it's Y", "you misread that") is the assistant's to address, not a human-to-human aside.
- SKIP only when the latest message is genuinely between people and unrelated to the assistant's work — small talk, an aside, or a bare acknowledgement ("thanks", "nice") that needs nothing further from it.
- When in doubt, RESPOND.
Answer with exactly one word: RESPOND or SKIP.`;

/**
 * The lightweight respond/skip gate for Atlas. The conductor is gate-less by default (it assumed a
 * 1:1 DM where every message is for Atlas), but the chat surface is a real Slack channel that can
 * contain OTHER humans — so Atlas must not run a full turn (or barge in) on every human-to-human
 * message. Hard rules are free + deterministic; only the genuinely ambiguous middle pays for a cheap
 * Haiku classify. Fail-OPEN to respond (a stray reply is cheaper than a missed request).
 *
 * Deliberately a fraction of the old multi-bot GateService: one bot, two actions (respond/skip), no
 * dormancy, no soft-ignore accumulator. Seed wakes (board verdicts, session relays) bypass it
 * entirely — the conductor only consults it for room-triggered turns.
 */
@Injectable()
export class AddressingGate {
  private readonly logger = new Logger(AddressingGate.name);

  constructor(
    private readonly employees: EmployeeRegistry,
    private readonly models: ChatModelFactory,
  ) {}

  async decide(
    opts: {
      bot: EmployeeDefinition;
      isDm: boolean;
      text: string;
      /** Recent channel lines (oldest first), for the classifier to judge continuation/context. */
      history: string;
    },
    /** The turn's LangGraph RunnableConfig — threaded into the Haiku call so the classify nests in
     * the turn's Langfuse trace (the gate runs in-graph). Omitted by direct/unit callers. */
    config?: RunnableConfig,
  ): Promise<GateDecision> {
    const { bot, isDm, text } = opts;
    // Hard rules (no LLM): a 1:1 DM, a broadcast, or Atlas addressed by @ or name → always respond.
    if (isDm) return this.verdict(bot.id, 'respond', 'dm');
    if (this.employees.isBroadcast(text))
      return this.verdict(bot.id, 'respond', 'broadcast');
    if (this.employees.addressedBots(text).some((b) => b.id === bot.id))
      return this.verdict(bot.id, 'respond', 'addressed');
    // Ambiguous: not a DM, not a broadcast, not addressed to Atlas — let a cheap model judge.
    try {
      const model = this.models.buildGateModel();
      const res = await model.invoke(
        [
          new SystemMessage(GATE_SYSTEM),
          new HumanMessage(
            `Recent channel context (oldest first):\n${opts.history}\n\nLatest message:\n${text}\n\nRESPOND or SKIP?`,
          ),
        ],
        config,
      );
      const out = (
        typeof res.content === 'string'
          ? res.content
          : JSON.stringify(res.content)
      ).toUpperCase();
      // Default to respond unless the model clearly said SKIP (fail-open).
      return out.includes('SKIP')
        ? this.verdict(bot.id, 'skip', 'classifier')
        : this.verdict(bot.id, 'respond', 'classifier');
    } catch (err) {
      this.logger.warn(
        `gate classify failed for ${bot.id}, defaulting to respond: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'respond';
    }
  }

  /**
   * Log + return a gate decision. A SKIP is the otherwise-invisible event — the turn ends with no
   * further log line — so it's the one a debugger reaches for ("why did Atlas stay quiet?") and is
   * logged at LOG level. A RESPOND is immediately followed by a full turn's worth of logs, so it stays
   * at DEBUG to avoid doubling every turn's opening line.
   */
  private verdict(
    botId: string,
    decision: GateDecision,
    reason: string,
  ): GateDecision {
    if (decision === 'skip') this.logger.log(`gate ${botId}: skip (${reason})`);
    else this.logger.debug(`gate ${botId}: respond (${reason})`);
    return decision;
  }
}
