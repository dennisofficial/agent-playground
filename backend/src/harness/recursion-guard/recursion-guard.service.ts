import type { AIMessage } from '@langchain/core/messages';
import { PromptTemplate } from '@langchain/core/prompts';
import {
  Runnable,
  RunnableLambda,
  RunnableSequence,
} from '@langchain/core/runnables';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { EnvService } from '@core/config/env/env.service';
import type { EmployeeDefinition } from '../employees/employee.types';
import { ChatModelFactory } from '../llm/chat-model.factory';

/** The guard's verdict — looping or not, with optional debug info. */
export interface GuardDecision {
  looping: boolean;
  /** One-line rationale from the model. Absent for fast-path no-ops. */
  reasoning?: string;
  usage?: { input: number; output: number };
}

const NOT_LOOPING: GuardDecision = { looping: false };

const Schema = z.object({
  reasoning: z
    .string()
    .describe(
      'one short sentence — is this bot stuck or making real progress?',
    ),
  looping: z
    .boolean()
    .describe(
      'true ONLY if the bot is clearly repeating itself with no new progress',
    ),
});
type SchemaT = z.infer<typeof Schema>;

// NOTE: the prompt is intentionally conservative. Normal iterative work — running a sequence of
// related steps, refining an answer, or alternating between clearly different actions — must NOT
// trigger the guard. Only an unambiguous, low-information repeat-loop should fire it.
const PROMPT = `You are watching {botName}'s recent messages for a STUCK, no-progress loop.

{botName}'s last messages (oldest first):
{window}

Is {botName} stuck — repeating the same statement, question, or action with no new progress?

Be CONSERVATIVE. Do NOT flag:
- Distinct sequential steps (even on the same topic)
- Alternating between two clearly different actions
- A back-and-forth where each reply adds genuinely new information
- A bot that said something once and then moved on

DO flag ONLY when the same conclusion, status, or action is repeated ≥ 2 times with nothing
new added — e.g., "still checking…" stalls, identical agreement strings, or the same
unanswered question re-asked verbatim.`;

/**
 * Rolling-window loop-detection circuit breaker. A single cheap Haiku call over a bot's last N
 * AI messages detects no-progress repetition — semantic/content loops that count-based caps miss.
 *
 * Always fail-open: a Haiku error or an unconfigured model returns `{ looping: false }` so the
 * guard never wedges or blocks a turn.
 *
 * Modelled on GateService (lazy chain, structured output, try/catch-to-safe-default).
 */
@Injectable()
export class RecursionGuardService {
  private chain?: Runnable<{ botName: string; window: string }, GuardDecision>;

  constructor(
    private readonly models: ChatModelFactory,
    private readonly env: EnvService,
  ) {}

  /** Whether the guard is active (default: on; `RECURSION_GUARD_ENABLED=false` disables). */
  isEnabled(): boolean {
    return this.env.get('RECURSION_GUARD_ENABLED') !== false;
  }

  /** How many of the bot's own AI messages to include in the rolling window (default: 12). */
  windowSize(): number {
    return this.env.get('RECURSION_GUARD_WINDOW') ?? 12;
  }

  private guard() {
    return (this.chain ??= RunnableSequence.from<
      { botName: string; window: string },
      GuardDecision
    >([
      new PromptTemplate<{ botName: string; window: string }>({
        template: PROMPT,
        inputVariables: ['botName', 'window'],
      }),
      // includeRaw so we can extract usage_metadata from the raw AIMessage.
      this.models.buildGuardModel().withStructuredOutput(Schema, {
        name: 'recursion_guard',
        includeRaw: true,
      }),
      RunnableLambda.from<{ raw: AIMessage; parsed: SchemaT }, GuardDecision>(
        ({ raw, parsed }) => {
          const u = raw.usage_metadata;
          const usage = u
            ? { input: u.input_tokens, output: u.output_tokens }
            : undefined;
          return {
            looping: parsed.looping,
            reasoning: parsed.reasoning,
            usage,
          };
        },
      ),
    ]).withConfig({ runName: 'Recursion Guard' }));
  }

  /**
   * Detect whether a bot is stuck in a no-progress loop based on its recent messages.
   *
   * `windowText` is a pre-rendered, newline-joined string of the bot's own last N AI
   * messages (already formatted by the caller — this service only judges, never slices).
   *
   * Fail-open: always returns `{ looping: false }` on any error so a model failure never
   * blocks or wedges a turn.
   */
  async detect(
    bot: EmployeeDefinition,
    windowText: string,
  ): Promise<GuardDecision> {
    if (!this.isEnabled()) return NOT_LOOPING;
    try {
      return await this.guard().invoke({
        botName: bot.name,
        window: windowText,
      });
    } catch {
      return NOT_LOOPING; // fail-open: never break a turn on a Haiku failure
    }
  }
}
