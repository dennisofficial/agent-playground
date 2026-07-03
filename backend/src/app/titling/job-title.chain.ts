import { SystemMessage } from '@langchain/core/messages';
import { ChatPromptTemplate, HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence, type Runnable } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Agent, renderAgentPrompt } from '../prompt-kit';

/**
 * The THREAD-TITLE chain — a tiny non-agentic LLM call that turns a thread's first message into a short,
 * human-readable title. Declarative LangChain composition (`prompt → llm → StringOutputParser`), the house
 * style: the chain is model-agnostic (`build(llm)`), so the per-org Anthropic key is resolved by the
 * provider factory (see `titling.module.ts`) and the same chain is unit-testable with a fake llm.
 *
 * Plain text out (a title is just a string) → `StringOutputParser`, no schema/tool-calling needed.
 */
export namespace JobTitleChain {
  /** The first message we're titling. */
  export interface Input {
    message: string;
  }
  export type Output = string;

  /** Cheap + fast: a title is a throwaway one-liner. Model is a code constant, never an env var. */
  export const MODEL = 'claude-haiku-4-5-20251001';

  /**
   * Build the chain over a given chat model. The user message is passed as a TEMPLATE VARIABLE (its value
   * is never re-parsed), so arbitrary braces/JSON in the message can't break prompt templating.
   */
  export const build = (llm: BaseChatModel): Runnable<Input, Output> =>
    RunnableSequence.from<Input, Output>([
      ChatPromptTemplate.fromMessages([
        new SystemMessage(renderAgentPrompt(Agent.META_TITLER)),
        // The message is fenced as data (never re-parsed — it's a template variable) so the model
        // reads it as the thing to title, not as a prompt addressed to it.
        HumanMessagePromptTemplate.fromTemplate(
          'Title this message:\n<message>\n{message}\n</message>',
        ),
      ]),
      llm,
      new StringOutputParser(),
    ]).withConfig({ runName: 'Thread Title' });
}

/** DI token for the per-org chain factory (a missing Anthropic key → `undefined`, caller no-ops). */
export const JOB_TITLE_CHAIN = Symbol('JOB_TITLE_CHAIN');
export type JobTitleChainFactory = (
  orgId?: string,
) => Promise<Runnable<JobTitleChain.Input, JobTitleChain.Output> | undefined>;

/**
 * A title that's actually the model talking to us instead of titling — "I appreciate the question,
 * but I'm designed to write task titles…", "Sorry, I can't…", "Sure, here's a title:". A real title is a
 * short noun phrase, never a first-person sentence, so we sniff for these shapes and reject them (the
 * caller then falls through to {@link firstLineTitle}). Conservative: only the unmistakable openers.
 */
const REFUSAL_SHAPE = /^(i\b|i'?m\b|sorry\b|as an?\b|sure[,!. ]|here(?:'s| is)\b|the title\b|okay[,!. ]|unfortunately\b|i appreciate\b|i cannot\b|i can'?t\b)/i;

/** Tidy a raw model title: drop surrounding quotes, collapse whitespace, cap length. Empty/refusal → undefined. */
export function sanitizeTitle(raw: string): string | undefined {
  const cleaned = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  if (!cleaned) return undefined;
  // The model answered/refused instead of titling — let the caller use the deterministic fallback.
  if (REFUSAL_SHAPE.test(cleaned)) return undefined;
  return cleaned;
}

/**
 * The deterministic FALLBACK title: the first non-empty line of `text`, capped at 80 chars. Used when no
 * title model is available (no key / LLM error / empty output). Previously duplicated as a private
 * `jobTitle` in the brain — now the single shared source so every fallback looks identical.
 */
export function firstLineTitle(text: string): string {
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) ?? text;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}
