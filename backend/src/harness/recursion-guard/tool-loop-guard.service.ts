import type { AIMessage } from '@langchain/core/messages';
import { PromptTemplate } from '@langchain/core/prompts';
import {
  Runnable,
  type RunnableConfig,
  RunnableLambda,
  RunnableSequence,
} from '@langchain/core/runnables';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { EnvService } from '@core/config/env/env.service';
import type { EmployeeDefinition } from '../employees/employee.types';
import { ChatModelFactory } from '../llm/chat-model.factory';

/** The TOOL-LOOP guard's verdict — is the repeated call making progress, or spinning? */
export interface ToolLoopDecision {
  /** `stuck` ONLY when the same call keeps returning redundant results with no new info. */
  verdict: 'progressing' | 'stuck';
  /** One-line rationale from the model. Absent for fast-path no-ops. */
  reasoning?: string;
  usage?: { input: number; output: number };
}

/** What the caller observed: the offending tool, its args, and what each call returned this turn. */
export interface ToolLoopObservation {
  toolName: string;
  /** The repeated call's arguments (already JSON-ish), rendered into the prompt verbatim. */
  args: string;
  /** Oldest-first one-line summaries of each result for this signature (e.g. "ok", "error: …"). */
  results: string[];
}

const PROGRESSING: ToolLoopDecision = { verdict: 'progressing' };

const Schema = z.object({
  reasoning: z
    .string()
    .describe('one short sentence — is this repeated call progressing or stuck?'),
  verdict: z
    .enum(['progressing', 'stuck'])
    .describe(
      "'stuck' ONLY when the call keeps returning the same/redundant result with no new progress",
    ),
});
type SchemaT = z.infer<typeof Schema>;

// Conservative by design: a repeated tool call is OFTEN legitimate — polling for an async result,
// retrying with backoff, or iterating over changing arguments. Only an unmistakable no-progress
// repeat — the SAME call returning the SAME result while the bot keeps re-issuing it — is `stuck`.
const PROMPT = `You are watching {botName} repeatedly call the SAME tool with the SAME arguments in one turn.

Tool: {toolName}
Arguments: {args}
Results so far (oldest first):
{results}

Is {botName} STUCK — re-issuing this identical call even though the results show it already
succeeded (or keeps returning the same thing), with no new progress?

Be CONSERVATIVE. Treat as 'progressing' (NOT stuck):
- Polling an async/long-running action whose result legitimately changes over time
- Retrying after a transient error (results show failures, not redundant successes)
- Any case where each result adds genuinely new information

Answer 'stuck' ONLY when the results are redundant — e.g. the action already succeeded and the
bot keeps re-doing it, or every call returns the same value and nothing new is happening.`;

/**
 * TOOL-CALL loop guard. Where {@link RecursionGuardService} watches a bot's SPOKEN messages for
 * conversational repetition at turn boundaries, this judges a single bot repeatedly calling the
 * SAME tool with the SAME arguments INSIDE the `llm ⇄ tools` loop — the failure mode where a stale
 * context block makes a bot re-issue an already-successful action (e.g. hammering `close_session`).
 *
 * Gated by a cheap DETERMINISTIC prefilter in the graph node (count of identical calls this turn);
 * this Haiku call runs ONLY once that prefilter trips, to tell a genuine stuck-loop from a
 * legitimate poll/retry.
 *
 * Always fail-open: a Haiku error or an unconfigured model returns `progressing` so the guard never
 * wedges or blocks a turn. Modelled on {@link RecursionGuardService}.
 */
@Injectable()
export class ToolLoopGuardService {
  private chain?: Runnable<
    { botName: string; toolName: string; args: string; results: string },
    ToolLoopDecision
  >;

  constructor(
    private readonly models: ChatModelFactory,
    private readonly env: EnvService,
  ) {}

  /** Whether the guard is active (default: on; `TOOL_LOOP_GUARD_ENABLED=false` disables). */
  isEnabled(): boolean {
    return this.env.get('TOOL_LOOP_GUARD_ENABLED') !== false;
  }

  /** How many identical `tool+args` calls in one turn before the Haiku check fires (default: 3). */
  threshold(): number {
    return this.env.get('TOOL_LOOP_GUARD_THRESHOLD') ?? 3;
  }

  private guard() {
    return (this.chain ??= RunnableSequence.from<
      { botName: string; toolName: string; args: string; results: string },
      ToolLoopDecision
    >([
      new PromptTemplate<{
        botName: string;
        toolName: string;
        args: string;
        results: string;
      }>({
        template: PROMPT,
        inputVariables: ['botName', 'toolName', 'args', 'results'],
      }),
      // includeRaw so we can extract usage_metadata from the raw AIMessage.
      this.models.buildGuardModel().withStructuredOutput(Schema, {
        name: 'tool_loop_guard',
        includeRaw: true,
      }),
      RunnableLambda.from<{ raw: AIMessage; parsed: SchemaT }, ToolLoopDecision>(
        ({ raw, parsed }) => {
          const u = raw.usage_metadata;
          const usage = u
            ? { input: u.input_tokens, output: u.output_tokens }
            : undefined;
          return {
            verdict: parsed.verdict,
            reasoning: parsed.reasoning,
            usage,
          };
        },
      ),
    ]).withConfig({ runName: 'Tool Loop Guard' }));
  }

  /**
   * Judge whether a repeated identical tool call is stuck or legitimately progressing.
   *
   * Fail-open: always returns `progressing` on any error so a model failure never blocks or
   * wedges a turn.
   */
  async detect(
    bot: EmployeeDefinition,
    obs: ToolLoopObservation,
    /** Forwarded to the guard chain so its LLM call nests under the turn's Langfuse trace. */
    config?: RunnableConfig,
  ): Promise<ToolLoopDecision> {
    if (!this.isEnabled()) return PROGRESSING;
    try {
      return await this.guard().invoke(
        {
          botName: bot.name,
          toolName: obs.toolName,
          args: obs.args,
          results: obs.results.map((r, i) => `${i + 1}. ${r}`).join('\n'),
        },
        config,
      );
    } catch {
      return PROGRESSING; // fail-open: never break a turn on a Haiku failure
    }
  }
}
