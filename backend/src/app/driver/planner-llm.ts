import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage } from '@langchain/core/messages';
import { ChatPromptTemplate, HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { RunnableLambda, RunnableSequence, type Runnable } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { z } from 'zod';
import type { Decision, DecisionRecord } from '../domain';

/**
 * W4 — the SECTION PLANNER's chat-model port. Isolated behind an interface + DI token (mirroring the
 * brain's `BRAIN_LLM` and the gate's `CLASSIFIER_LLM`) so the driver is unit-testable
 * WITHOUT a real LLM call — the driver tests bind a fake that returns a fixed phase list.
 *
 * The planner runs at most ONE structured call per section: take the section brief + the locked
 * decision record (overview + decisions) + the prior section's handoff, return a phased plan (an
 * ordered list of phases). The phases LOCK once returned (persisted as `phases` rows). A separate
 * one-shot `extractDecisions` call mines the plan for the notable always-ask-shaped calls the gate then
 * classifies, and a one-shot `handoff` call summarizes what a finished section produced for the next.
 *
 * The LLM mechanics are declarative LangChain chains (`prompt → llm.withStructuredOutput(zod)`, and a
 * plain `StringOutputParser` for the text handoff) — the house style, NOT hand-rolled `bindTools` +
 * `tool_calls` digging. Model is a code constant (Sonnet). Key-less → every method returns `undefined`,
 * and the driver falls back to a single-phase plan / the brief itself (degrades, never throws).
 */

/** One phase of a section's locked plan, as the planner emits it (pre-persistence). */
export interface PlannedPhase {
  /** Short phase title ("Add the persistence layer"). */
  title: string;
  /** The phase brief — the concrete instructions an execute turn runs. */
  brief: string;
}

/** The inputs to ONE section-plan turn. */
export interface PlanSectionInput {
  /** The feature's agreed overview (the decision record's `overview`). */
  overview: string;
  /** The locked architecture/system calls — phases must respect these, not re-litigate them. */
  decisions: Decision[];
  /** This section's one-line brief from the upfront section list. */
  brief: string;
  /** The prior section's handoff note (null for the first section). */
  handoffIn: string | null;
  /** The tenant whose Anthropic key backs this call (omit → env fallback). */
  orgId?: string;
}

/** A decision the planner surfaced from its own plan for the gate to classify. */
export interface PlannedDecision {
  /** One-line description of the call the plan makes. */
  description: string;
  /** Where in the plan it shows up (light context for the classifier). */
  context?: string;
}

export interface PlannerLlm {
  /**
   * Produce the section's phased plan: an ordered list of phases grounded in the decision record + the
   * prior handoff. Returns `undefined` when no LLM is available — the driver then runs the section as a
   * single phase whose brief IS the section brief (a degraded-but-correct fallback).
   */
  planSection(input: PlanSectionInput): Promise<PlannedPhase[] | undefined>;
  /**
   * One Codex/engine-style review pass over a draft plan → a single revised plan, OR `undefined` when
   * the plan needs no change / no LLM is available (the driver keeps the original). Clean single loop.
   */
  reviewPlan(input: PlanSectionInput & { draft: PlannedPhase[] }): Promise<PlannedPhase[] | undefined>;
  /**
   * Mine the section's plan for the NOTABLE decisions it makes (the always-ask-shaped calls), so the
   * gate can classify them against the record. Empty/`undefined` → the section has no flagged decision.
   */
  extractDecisions(input: PlanSectionInput & { phases: PlannedPhase[] }): Promise<PlannedDecision[] | undefined>;
  /**
   * Summarize what a finished section produced (its handoff note for the next section's plan). Returns
   * `undefined` when no LLM is available — the driver falls back to a terse rule-based summary.
   */
  handoff(input: {
    brief: string;
    phases: PlannedPhase[];
    reports: string[];
    orgId?: string;
  }): Promise<string | undefined>;
}

export const PLANNER_LLM = Symbol('PLANNER_LLM');

/**
 * The section-planner chains. One namespace, four declarative chains — all sharing the rendered plan
 * context as a single `{input}` template variable (so arbitrary content can't break templating).
 */
export namespace PlannerChains {
  export const MODEL = 'claude-sonnet-4-5-20250929';

  const PHASES_SCHEMA = z.object({
    phases: z.array(z.object({ title: z.string(), brief: z.string() })),
  });
  const DECISIONS_SCHEMA = z.object({
    decisions: z.array(z.object({ description: z.string(), context: z.string().optional() })),
  });

  const PLAN_SYSTEM = [
    "You are Atlas's section planner. You turn ONE section of an approved feature into a concrete, ordered",
    'list of PHASES. A phase is a single focused unit of work an engineer completes in one sitting (one',
    'fresh engine session). Keep phases coherent and sequential — later phases build on earlier ones.',
    '',
    'You are bound by the LOCKED decision record: respect its architecture/system calls, do NOT re-litigate',
    'them. Plan only HOW to implement this section within those calls. Prefer 1–4 phases; a small section',
    'is ONE phase. Each phase needs a short title and a concrete brief (what to build, which files/areas).',
    '',
    "ALWAYS make the LAST phase a VERIFICATION phase: run the repo's own typecheck/build/tests and confirm",
    "the section's change actually works (not a guess). If the section DELETES or removes code, an early",
    'phase must first PROVE the target is unused — find every importer, intra-file caller, and dynamic/string',
    'reference — before a later phase removes it. Do not plan a standalone "investigate the codebase" phase',
    '(the repo is already investigated upstream).',
  ].join('\n');

  const REVIEW_SYSTEM = [
    'You are a senior reviewer doing ONE pass over a draft section plan (the Codex review loop). Tighten it:',
    'merge redundant phases, split an overloaded one, fix ordering, surface a missing step. Make the SMALLEST',
    'set of changes that materially improves it — if it is already sound, return it unchanged. Stay within the',
    'locked decision record (return the full revised phase list).',
  ].join('\n');

  const EXTRACT_SYSTEM = [
    "You read a section's phased plan and list the NOTABLE engineering decisions it makes that a human might",
    'want to weigh in on — schema/data-model changes, public/cross-service API contracts, new dependencies or',
    'services, infrastructure/topology, cross-cutting patterns (auth/caching/state/concurrency/error-handling),',
    'and one-way doors. Skip pure internal mechanics (naming, file placement, refactors). Each item is one line.',
    '',
    'Be EXHAUSTIVE about SECURITY & AUTH-MECHANISM decisions — surface each as its OWN item, never bundled:',
    'the password-hashing algorithm, the JWT/token library choice, the token strategy (signing algo, expiry,',
    'refresh/rotation, storage location), OAuth/SSO/SAML, session/cookie strategy, encryption/crypto, secret',
    'storage. A plan that "adds JWT auth" makes SEVERAL such decisions — list them all.',
    '',
    'If the plan makes none, return an empty list.',
  ].join('\n');

  const HANDOFF_SYSTEM = [
    'You summarize what a just-finished section produced so the NEXT section can build on it. Two or three',
    'sentences: what now exists (modules/contracts/endpoints), and anything the next section must know. Be',
    'concrete and terse. Reply with plain text.',
  ].join('\n');

  /** Compose `system + {input}` → structured/typed phases, for an input rendered by `renderUser`. */
  const phasesChain = <I>(
    llm: BaseChatModel,
    system: string,
    renderUser: (i: I) => string,
  ): Runnable<I, PlannedPhase[]> =>
    RunnableSequence.from<I, PlannedPhase[]>([
      RunnableLambda.from((i: I) => ({ input: renderUser(i) })),
      ChatPromptTemplate.fromMessages([
        new SystemMessage(system),
        HumanMessagePromptTemplate.fromTemplate('{input}'),
      ]),
      llm.withStructuredOutput(PHASES_SCHEMA, { name: 'emit_phases' }),
      RunnableLambda.from((o: z.infer<typeof PHASES_SCHEMA>) => o.phases),
    ]);

  export const planSection = (llm: BaseChatModel): Runnable<PlanSectionInput, PlannedPhase[]> =>
    phasesChain<PlanSectionInput>(llm, PLAN_SYSTEM, (i) => renderPlanContext(i)).withConfig({
      runName: 'Plan Section',
    });

  export const reviewPlan = (
    llm: BaseChatModel,
  ): Runnable<PlanSectionInput & { draft: PlannedPhase[] }, PlannedPhase[]> =>
    phasesChain<PlanSectionInput & { draft: PlannedPhase[] }>(llm, REVIEW_SYSTEM, (i) => {
      const draft = i.draft.map((p, n) => `${n + 1}. ${p.title}: ${p.brief}`).join('\n');
      return `${renderPlanContext(i)}\n\nDraft plan:\n${draft}`;
    }).withConfig({ runName: 'Review Plan' });

  export const extractDecisions = (
    llm: BaseChatModel,
  ): Runnable<{ brief: string; phases: PlannedPhase[] }, PlannedDecision[]> =>
    RunnableSequence.from<{ brief: string; phases: PlannedPhase[] }, PlannedDecision[]>([
      RunnableLambda.from((i: { brief: string; phases: PlannedPhase[] }) => {
        const phases = i.phases.map((p, n) => `${n + 1}. ${p.title}: ${p.brief}`).join('\n');
        return { input: `Section: ${i.brief}\n\nPlan:\n${phases}` };
      }),
      ChatPromptTemplate.fromMessages([
        new SystemMessage(EXTRACT_SYSTEM),
        HumanMessagePromptTemplate.fromTemplate('{input}'),
      ]),
      llm.withStructuredOutput(DECISIONS_SCHEMA, { name: 'emit_decisions' }),
      RunnableLambda.from((o: z.infer<typeof DECISIONS_SCHEMA>) =>
        o.decisions
          .filter((d) => Boolean(d.description))
          .map((d) => ({ description: d.description, ...(d.context ? { context: d.context } : {}) })),
      ),
    ]).withConfig({ runName: 'Extract Decisions' });

  export const handoff = (
    llm: BaseChatModel,
  ): Runnable<{ brief: string; phases: PlannedPhase[]; reports: string[] }, string> =>
    RunnableSequence.from<{ brief: string; phases: PlannedPhase[]; reports: string[] }, string>([
      RunnableLambda.from((i: { brief: string; phases: PlannedPhase[]; reports: string[] }) => {
        const phases = i.phases.map((p) => `- ${p.title}`).join('\n');
        const reports = i.reports.map((r, n) => `Phase ${n + 1} report: ${r}`).join('\n\n');
        return { input: `Section: ${i.brief}\n\nPhases:\n${phases}\n\n${reports}`.slice(0, 16000) };
      }),
      ChatPromptTemplate.fromMessages([
        new SystemMessage(HANDOFF_SYSTEM),
        HumanMessagePromptTemplate.fromTemplate('{input}'),
      ]),
      llm,
      new StringOutputParser(),
    ]).withConfig({ runName: 'Section Handoff' });
}

/**
 * The real adapter. Lazy by construction — no chain until the first call; a missing key returns
 * `undefined` everywhere (the driver falls back). Cheap structured calls; one ChatAnthropic cached per
 * key string (the chains are rebuilt per call — composition is cheap).
 */
export class AnthropicPlannerLlm implements PlannerLlm {
  private readonly models = new Map<string, ChatAnthropic>();

  constructor(private readonly apiKey: (orgId?: string) => Promise<string | undefined>) {}

  private async model(orgId?: string): Promise<ChatAnthropic | undefined> {
    const key = await this.apiKey(orgId);
    if (!key) return undefined;
    let m = this.models.get(key);
    if (!m) {
      m = new ChatAnthropic({
        apiKey: key,
        model: PlannerChains.MODEL,
        maxTokens: 4096,
        temperature: 0,
      });
      this.models.set(key, m);
    }
    return m;
  }

  async planSection(input: PlanSectionInput): Promise<PlannedPhase[] | undefined> {
    const llm = await this.model(input.orgId);
    if (!llm) return undefined;
    try {
      const phases = await PlannerChains.planSection(llm).invoke(input);
      return phases.length ? phases : undefined;
    } catch {
      return undefined;
    }
  }

  async reviewPlan(
    input: PlanSectionInput & { draft: PlannedPhase[] },
  ): Promise<PlannedPhase[] | undefined> {
    const llm = await this.model(input.orgId);
    if (!llm) return undefined;
    try {
      const phases = await PlannerChains.reviewPlan(llm).invoke(input);
      return phases.length ? phases : undefined;
    } catch {
      return undefined;
    }
  }

  async extractDecisions(
    input: PlanSectionInput & { phases: PlannedPhase[] },
  ): Promise<PlannedDecision[] | undefined> {
    const llm = await this.model(input.orgId);
    if (!llm) return undefined;
    try {
      return await PlannerChains.extractDecisions(llm).invoke({ brief: input.brief, phases: input.phases });
    } catch {
      return undefined;
    }
  }

  async handoff(input: {
    brief: string;
    phases: PlannedPhase[];
    reports: string[];
    orgId?: string;
  }): Promise<string | undefined> {
    const llm = await this.model(input.orgId);
    if (!llm) return undefined;
    try {
      const text = await PlannerChains.handoff(llm).invoke({
        brief: input.brief,
        phases: input.phases,
        reports: input.reports,
      });
      return text.trim() || undefined;
    } catch {
      return undefined;
    }
  }
}

/** Render the shared plan context (overview + locked decisions + brief + handoff) for a prompt. */
export function renderPlanContext(input: PlanSectionInput): string {
  const decisions = input.decisions.length
    ? input.decisions.map((d) => `- [${d.decisionClass}] ${d.title}: ${d.ruling}`).join('\n')
    : '(none)';
  const handoff = input.handoffIn ? `\n\nPrior section handoff:\n${input.handoffIn}` : '';
  return [
    `Feature overview:\n${input.overview}`,
    `\nLocked decisions (respect these):\n${decisions}`,
    `\nThis section's brief:\n${input.brief}${handoff}`,
  ].join('\n');
}

/** The slim record slice the planner reads (overview + decisions). */
export type PlannerRecord = Pick<DecisionRecord, 'overview' | 'decisions'>;
