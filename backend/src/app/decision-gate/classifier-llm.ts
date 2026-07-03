import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage } from '@langchain/core/messages';
import { ChatPromptTemplate, HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { RunnableLambda, RunnableSequence, type Runnable } from '@langchain/core/runnables';
import { z } from 'zod';
import { fence, fenceOrNone } from '../prompt-fence';
import { Agent, renderAgentPrompt } from '../prompt-kit';

/**
 * The ambiguous-case LLM port for the decision-class gate. Isolated behind an interface + DI token so
 * the classifier is unit-testable WITHOUT a real LLM call (tests bind a fake), and so the gate pays a
 * model call ONLY for the genuinely ambiguous tail — the deterministic rules settle the well-defined
 * classes first.
 *
 * The LLM mechanics are a declarative LangChain chain (`prompt → llm.withStructuredOutput(zod)`), the
 * house style — NOT hand-rolled `bindTools` + `tool_calls` digging. The model is a code constant (Haiku);
 * the per-org Anthropic key is the only env-fed input.
 */

/** The cheap-model decision the LLM returns for an ambiguous proposed decision. */
export interface ClassifierLlmVerdict {
  /** `ask` = an uncovered always-ask class; `proceed` = a never-ask call. (Never `covered` — the rules
   * own coverage; the LLM only adjudicates ask-vs-proceed.) */
  verdict: 'ask' | 'proceed';
  /** The always-ask class, when the LLM judged `ask`. */
  decisionClass?: string;
  /** One short line of reasoning. */
  reason: string;
}

export interface ClassifierLlm {
  /**
   * Adjudicate an ambiguous decision the deterministic rules couldn't settle. MUST be conservative:
   * when unsure between ask and proceed, return `ask`.
   * @returns the verdict, or `undefined` if no LLM is available (no key) — the caller then defaults to
   *          the conservative `ask`.
   */
  classify(input: {
    description: string;
    context?: string;
    /** A compact listing of the already-locked decisions, so the LLM doesn't re-ask a settled call. */
    recordSummary: string;
    /** The tenant whose Anthropic key backs this call (omit → env fallback). */
    orgId?: string;
  }): Promise<ClassifierLlmVerdict | undefined>;
}

export const CLASSIFIER_LLM = Symbol('CLASSIFIER_LLM');

/**
 * The decision-class classifier chain — a cheap, structured Haiku call. Declarative composition; the
 * untrusted decision text is passed as a TEMPLATE VARIABLE (its value is never re-parsed), so embedded
 * braces / injection text can't break templating.
 */
export namespace ClassifyDecisionChain {
  export interface Input {
    description: string;
    context?: string;
    recordSummary: string;
  }

  export const Schema = z.object({
    verdict: z.enum(['ask', 'proceed']),
    decisionClass: z
      .enum([
        'data_model',
        'api_contract',
        'dependency',
        'infrastructure',
        'cross_cutting',
        'one_way_door',
      ])
      .optional()
      .describe('The always-ask class — required when verdict is "ask".'),
    reason: z.string().describe('One short line.'),
  });
  export type Output = z.infer<typeof Schema>;

  export const MODEL = 'claude-haiku-4-5-20251001';

  const renderUser = (i: Input): string =>
    [
      fenceOrNone('locked_decisions', i.recordSummary),
      fence('proposed_decision', i.description),
      i.context ? fence('decision_context', i.context) : '',
    ]
      .filter(Boolean)
      .join('\n\n');

  export const build = (llm: BaseChatModel): Runnable<Input, Output> =>
    RunnableSequence.from<Input, Output>([
      RunnableLambda.from((i: Input) => ({ input: renderUser(i) })),
      ChatPromptTemplate.fromMessages([
        new SystemMessage(renderAgentPrompt(Agent.META_CLASSIFIER)),
        HumanMessagePromptTemplate.fromTemplate('{input}'),
      ]),
      llm.withStructuredOutput(Schema, { name: 'classify_decision' }),
    ]).withConfig({ runName: 'Classify Decision' });
}

/**
 * The real adapter. Lazy by construction — no chain until the first classify; a missing key returns
 * `undefined` (gate defaults to ask) rather than throwing. Cheap structured Haiku call; chains cached
 * per key string.
 */
export class AnthropicClassifierLlm implements ClassifierLlm {
  private readonly chains = new Map<string, Runnable<ClassifyDecisionChain.Input, ClassifyDecisionChain.Output>>();

  /** @param apiKey resolves the active Anthropic key for a tenant (e.g. CredentialResolver.anthropicKey). */
  constructor(private readonly apiKey: (orgId?: string) => Promise<string | undefined>) {}

  private async chain(
    orgId?: string,
  ): Promise<Runnable<ClassifyDecisionChain.Input, ClassifyDecisionChain.Output> | undefined> {
    const key = await this.apiKey(orgId);
    if (!key) return undefined;
    let c = this.chains.get(key);
    if (!c) {
      c = ClassifyDecisionChain.build(
        new ChatAnthropic({
          apiKey: key,
          model: ClassifyDecisionChain.MODEL,
          maxTokens: 256,
          temperature: 0,
        }),
      );
      this.chains.set(key, c);
    }
    return c;
  }

  async classify(input: {
    description: string;
    context?: string;
    recordSummary: string;
    orgId?: string;
  }): Promise<ClassifierLlmVerdict | undefined> {
    const chain = await this.chain(input.orgId);
    if (!chain) return undefined;
    try {
      const out = await chain.invoke({
        description: input.description,
        ...(input.context ? { context: input.context } : {}),
        recordSummary: input.recordSummary,
      });
      return {
        verdict: out.verdict,
        ...(out.decisionClass ? { decisionClass: out.decisionClass } : {}),
        reason: out.reason || '(no reason given)',
      };
    } catch {
      // Malformed/blocked structured output → be conservative; the caller defaults to ask.
      return undefined;
    }
  }
}
