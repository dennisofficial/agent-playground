import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage } from '@langchain/core/messages';
import { ChatPromptTemplate, HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { RunnableLambda, RunnableSequence, type Runnable } from '@langchain/core/runnables';
import { z } from 'zod';
import { fence, fenceOrNone } from '../prompt-fence';
import { Agent, renderAgentPrompt } from '../prompt-kit';

/**
 * The live-verification judge (ADR 0005 — Phase 2 of ADR 0004's thread termination contract). Isolated
 * behind an interface + DI token, mirroring `decision-gate/classifier-llm.ts` 1:1 in shape, so the gate is
 * unit-testable WITHOUT a real LLM call and the judge is a cheap, structured Haiku call — same
 * conservative-default philosophy: unavailable/malformed → `undefined`, and the CALLER decides the
 * conservative fallback (never this file).
 *
 * ⚠️ `missingChecks` is a single semicolon-joined STRING, not `string[]` — deliberately, to sidestep the
 * known Sonnet-5-breaks-`withStructuredOutput`-on-array-fields gotcha (see the `atlas-ai-eval-harness-
 * sonnet5-structured-output` memory). `classifier-llm.ts`'s own schema has zero array fields; this is new
 * territory, so the schema avoids the risk class entirely rather than relying on Haiku being safe with it.
 */

/** The judge's verdict on one thread's `complete_thread` claim. */
export interface LiveVerificationVerdict {
  /** Did the diff touch an HTTP endpoint/route, a UI page/component, a CLI entry point, or a bg job? */
  runtimeSurfaceTouched: boolean;
  /** Only meaningful when `runtimeSurfaceTouched` — was it actually exercised live (not just build/test)? */
  liveVerificationAdequate: boolean;
  /** One short line of reasoning. */
  reason: string;
  /** One short semicolon-joined line naming what live check is missing — STRING, not an array. */
  missingChecks?: string;
}

export interface LiveVerificationJudge {
  /**
   * Judge one thread's completion claim. MUST be conservative: the LLM should resolve toward the
   * stricter reading when unsure — but this method may also just be unavailable (no key).
   * @returns the verdict, or `undefined` if no LLM is available/the output was malformed — the caller
   *          then applies its own conservative default (see `complete_thread`'s handler).
   */
  judge(input: {
    /** Rendered summary/changes/verification/deviations/gaps from the terminal record — untrusted, fenced. */
    terminalRecordSummary: string;
    /** The thread's changed files (from `LocalGitService.changedFileNames`) — the per-thread diff signal. */
    changedFiles: string[];
    /** A compact listing of the already-locked decisions, for context. */
    lockedDecisionsSummary: string;
    /** The tenant whose Anthropic key backs this call (omit → env fallback). */
    orgId?: string;
  }): Promise<LiveVerificationVerdict | undefined>;
}

export const LIVE_VERIFICATION_JUDGE = Symbol('LIVE_VERIFICATION_JUDGE');

/**
 * The live-verification judge chain — a cheap, structured Haiku call. Declarative composition; the
 * untrusted terminal-record summary / changed-files list are passed as TEMPLATE VARIABLES (never
 * re-parsed), so embedded braces / injection text can't break templating.
 */
export namespace JudgeLiveVerificationChain {
  export interface Input {
    terminalRecordSummary: string;
    changedFiles: string[];
    lockedDecisionsSummary: string;
  }

  export const Schema = z.object({
    runtimeSurfaceTouched: z.boolean(),
    liveVerificationAdequate: z.boolean(),
    reason: z.string().describe('One short line.'),
    missingChecks: z
      .string()
      .optional()
      .describe('One short semicolon-joined line naming what live check is missing.'),
  });
  export type Output = z.infer<typeof Schema>;

  export const MODEL = 'claude-haiku-4-5-20251001';

  const renderUser = (i: Input): string =>
    [
      fenceOrNone('locked_decisions', i.lockedDecisionsSummary),
      fence('terminal_record', i.terminalRecordSummary),
      fenceOrNone('changed_files', i.changedFiles.join('\n')),
    ].join('\n\n');

  export const build = (llm: BaseChatModel): Runnable<Input, Output> =>
    RunnableSequence.from<Input, Output>([
      RunnableLambda.from((i: Input) => ({ input: renderUser(i) })),
      ChatPromptTemplate.fromMessages([
        new SystemMessage(renderAgentPrompt(Agent.META_LIVE_VERIFICATION_JUDGE)),
        HumanMessagePromptTemplate.fromTemplate('{input}'),
      ]),
      llm.withStructuredOutput(Schema, { name: 'judge_live_verification' }),
    ]).withConfig({ runName: 'Judge Live Verification' });
}

/**
 * The real adapter. Lazy by construction — no chain until the first judge call; a missing key returns
 * `undefined` (caller defaults conservative) rather than throwing. Cheap structured Haiku call; chains
 * cached per key string.
 */
export class AnthropicLiveVerificationJudge implements LiveVerificationJudge {
  private readonly chains = new Map<
    string,
    Runnable<JudgeLiveVerificationChain.Input, JudgeLiveVerificationChain.Output>
  >();

  /** @param apiKey resolves the active Anthropic key for a tenant (e.g. CredentialResolver.anthropicKey). */
  constructor(private readonly apiKey: (orgId?: string) => Promise<string | undefined>) {}

  private async chain(
    orgId?: string,
  ): Promise<Runnable<JudgeLiveVerificationChain.Input, JudgeLiveVerificationChain.Output> | undefined> {
    const key = await this.apiKey(orgId);
    if (!key) return undefined;
    let c = this.chains.get(key);
    if (!c) {
      c = JudgeLiveVerificationChain.build(
        new ChatAnthropic({
          apiKey: key,
          model: JudgeLiveVerificationChain.MODEL,
          maxTokens: 256,
          temperature: 0,
        }),
      );
      this.chains.set(key, c);
    }
    return c;
  }

  async judge(input: {
    terminalRecordSummary: string;
    changedFiles: string[];
    lockedDecisionsSummary: string;
    orgId?: string;
  }): Promise<LiveVerificationVerdict | undefined> {
    const chain = await this.chain(input.orgId);
    if (!chain) return undefined;
    try {
      const out = await chain.invoke({
        terminalRecordSummary: input.terminalRecordSummary,
        changedFiles: input.changedFiles,
        lockedDecisionsSummary: input.lockedDecisionsSummary,
      });
      return {
        runtimeSurfaceTouched: out.runtimeSurfaceTouched,
        liveVerificationAdequate: out.liveVerificationAdequate,
        reason: out.reason || '(no reason given)',
        ...(out.missingChecks ? { missingChecks: out.missingChecks } : {}),
      };
    } catch {
      // Malformed/blocked structured output → be conservative; the caller defaults accordingly.
      return undefined;
    }
  }
}
