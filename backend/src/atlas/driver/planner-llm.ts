import { ChatAnthropic } from '@langchain/anthropic';
import type { Decision, DecisionRecord } from '../domain';

/**
 * W4 — the SECTION PLANNER's chat-model port. Isolated behind an interface + DI token (mirroring the
 * brain's `ATLAS_BRAIN_LLM` and the gate's `ATLAS_CLASSIFIER_LLM`) so the driver is unit-testable
 * WITHOUT a real LLM call — the driver tests bind a fake that returns a fixed phase list.
 *
 * The planner runs at most ONE structured call per section: take the section brief + the locked
 * decision record (overview + decisions) + the prior section's handoff, return a phased plan (an
 * ordered list of phases). The phases LOCK once returned (persisted as `atlas_phases` rows). A separate
 * one-shot `extractDecisions` call mines the plan for the notable always-ask-shaped calls the gate then
 * classifies, and a one-shot `handoff` call summarizes what a finished section produced for the next.
 *
 * Clean-room: a tiny direct `ChatAnthropic` use (LangChain is dual-published / statically importable),
 * NOT v1's `ChatModelFactory`. Zero v1 imports. Key-less → every method returns `undefined`, and the
 * driver falls back to a single-phase plan / the brief itself (degrades, never throws).
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
  handoff(input: { brief: string; phases: PlannedPhase[]; reports: string[] }): Promise<string | undefined>;
}

export const ATLAS_PLANNER_LLM = Symbol('ATLAS_PLANNER_LLM');

const PLAN_SYSTEM = [
  'You are Atlas\'s section planner. You turn ONE section of an approved feature into a concrete, ordered',
  'list of PHASES. A phase is a single focused unit of work an engineer completes in one sitting (one',
  'fresh engine session). Keep phases coherent and sequential — later phases build on earlier ones.',
  '',
  'You are bound by the LOCKED decision record: respect its architecture/system calls, do NOT re-litigate',
  'them. Plan only HOW to implement this section within those calls. Prefer 1–4 phases; a small section',
  'is ONE phase. Each phase needs a short title and a concrete brief (what to build, which files/areas).',
  '',
  'ALWAYS make the LAST phase a VERIFICATION phase: run the repo\'s own typecheck/build/tests and confirm',
  'the section\'s change actually works (not a guess). If the section DELETES or removes code, an early',
  'phase must first PROVE the target is unused — find every importer, intra-file caller, and dynamic/string',
  'reference — before a later phase removes it. Do not plan a standalone "investigate the codebase" phase',
  '(the repo is already investigated upstream). Reply with ONLY the tool call.',
].join('\n');

const REVIEW_SYSTEM = [
  'You are a senior reviewer doing ONE pass over a draft section plan (the Codex review loop). Tighten it:',
  'merge redundant phases, split an overloaded one, fix ordering, surface a missing step. Make the SMALLEST',
  'set of changes that materially improves it — if it is already sound, return it unchanged. Stay within the',
  'locked decision record. Reply with ONLY the tool call (the full revised phase list).',
].join('\n');

const EXTRACT_SYSTEM = [
  'You read a section\'s phased plan and list the NOTABLE engineering decisions it makes that a human might',
  'want to weigh in on — schema/data-model changes, public/cross-service API contracts, new dependencies or',
  'services, infrastructure/topology, cross-cutting patterns (auth/caching/state/concurrency/error-handling),',
  'and one-way doors. Skip pure internal mechanics (naming, file placement, refactors). Each item is one line.',
  'If the plan makes none, return an empty list. Reply with ONLY the tool call.',
].join('\n');

const HANDOFF_SYSTEM = [
  'You summarize what a just-finished section produced so the NEXT section can build on it. Two or three',
  'sentences: what now exists (modules/contracts/endpoints), and anything the next section must know. Be',
  'concrete and terse. Reply with plain text (no tool call).',
].join('\n');

const PHASES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    phases: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          brief: { type: 'string' },
        },
        required: ['title', 'brief'],
      },
    },
  },
  required: ['phases'],
} as const;

/**
 * The real adapter. Lazy by construction — no client until the first call; a missing key returns
 * `undefined` everywhere (the driver falls back). Reuses the chat-model env (`ANTHROPIC_API_KEY` +
 * `CHAT_MODEL`), cheap structured tool calls, clients cached per key string. Zero v1 imports.
 */
export class AnthropicPlannerLlm implements PlannerLlm {
  private readonly clients = new Map<string, ChatAnthropic>();

  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly model: () => string | undefined,
  ) {}

  private client(): ChatAnthropic | undefined {
    const key = this.apiKey();
    if (!key) return undefined;
    let c = this.clients.get(key);
    if (!c) {
      c = new ChatAnthropic({
        apiKey: key,
        model: this.model() ?? 'claude-sonnet-4-5-20250929',
        maxTokens: 4096,
        temperature: 0,
      });
      this.clients.set(key, c);
    }
    return c;
  }

  async planSection(input: PlanSectionInput): Promise<PlannedPhase[] | undefined> {
    const model = this.client();
    if (!model) return undefined;
    const bound = model.bindTools(
      [{ name: 'emit_phases', description: 'Emit the section\'s ordered phase list.', schema: PHASES_SCHEMA }],
      { tool_choice: 'emit_phases' },
    );
    const res = await bound.invoke([
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: renderPlanContext(input) },
    ]);
    return parsePhases(res.tool_calls?.[0]?.args);
  }

  async reviewPlan(
    input: PlanSectionInput & { draft: PlannedPhase[] },
  ): Promise<PlannedPhase[] | undefined> {
    const model = this.client();
    if (!model) return undefined;
    const bound = model.bindTools(
      [{ name: 'emit_phases', description: 'Emit the revised phase list.', schema: PHASES_SCHEMA }],
      { tool_choice: 'emit_phases' },
    );
    const draft = input.draft.map((p, i) => `${i + 1}. ${p.title}: ${p.brief}`).join('\n');
    const res = await bound.invoke([
      { role: 'system', content: REVIEW_SYSTEM },
      { role: 'user', content: `${renderPlanContext(input)}\n\nDraft plan:\n${draft}` },
    ]);
    return parsePhases(res.tool_calls?.[0]?.args);
  }

  async extractDecisions(
    input: PlanSectionInput & { phases: PlannedPhase[] },
  ): Promise<PlannedDecision[] | undefined> {
    const model = this.client();
    if (!model) return undefined;
    const bound = model.bindTools(
      [
        {
          name: 'emit_decisions',
          description: 'List the notable decisions the plan makes.',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              decisions: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    description: { type: 'string' },
                    context: { type: 'string' },
                  },
                  required: ['description'],
                },
              },
            },
            required: ['decisions'],
          },
        },
      ],
      { tool_choice: 'emit_decisions' },
    );
    const phases = input.phases.map((p, i) => `${i + 1}. ${p.title}: ${p.brief}`).join('\n');
    const res = await bound.invoke([
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: `Section: ${input.brief}\n\nPlan:\n${phases}` },
    ]);
    const raw = (res.tool_calls?.[0]?.args ?? {}) as {
      decisions?: Array<{ description?: string; context?: string }>;
    };
    return (raw.decisions ?? [])
      .filter((d): d is { description: string; context?: string } => Boolean(d.description))
      .map((d) => ({ description: d.description, ...(d.context ? { context: d.context } : {}) }));
  }

  async handoff(input: {
    brief: string;
    phases: PlannedPhase[];
    reports: string[];
  }): Promise<string | undefined> {
    const model = this.client();
    if (!model) return undefined;
    const phases = input.phases.map((p) => `- ${p.title}`).join('\n');
    const reports = input.reports.map((r, i) => `Phase ${i + 1} report: ${r}`).join('\n\n');
    const res = await model.invoke([
      { role: 'system', content: HANDOFF_SYSTEM },
      {
        role: 'user',
        content: `Section: ${input.brief}\n\nPhases:\n${phases}\n\n${reports}`.slice(0, 16000),
      },
    ]);
    const text = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
    return text.trim() || undefined;
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

/** Coerce raw tool args into a `PlannedPhase[]`, or undefined if malformed/empty. Exported for tests. */
export function parsePhases(raw: unknown): PlannedPhase[] | undefined {
  const args = (raw ?? {}) as { phases?: Array<{ title?: string; brief?: string }> };
  const phases = (args.phases ?? [])
    .filter((p): p is { title: string; brief: string } => Boolean(p.title && p.brief))
    .map((p) => ({ title: p.title, brief: p.brief }));
  return phases.length ? phases : undefined;
}

/** The slim record slice the planner reads (overview + decisions). */
export type PlannerRecord = Pick<DecisionRecord, 'overview' | 'decisions'>;
