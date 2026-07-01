import { ChatAnthropic } from '@langchain/anthropic';
import { defineModule, llmJudge, scorer } from '@workspace/ai-testing';
import { PlannerChains, type PlanThreadInput, type PlannedStep } from './planner-llm';
import { DATASET } from './planner-llm.ai.data';

/**
 * Real-LLM eval for the track planner (`PlannerChains.MODEL`, currently Opus 4.8).
 * Run from `backend/`: `pnpm eval planner` (real calls, costs money) or `pnpm eval:check planner`
 * (loads + validates the module WITHOUT any LLM call).
 *
 * The runnable mirrors the production `AnthropicPlannerLlm` model config EXACTLY — same model +
 * maxTokens, no temperature (Opus 4.8 rejects a non-default one) — so this grades the planner as it
 * actually runs in the driver. (History: Sonnet 5 was tried and its forced-tool-calling structured
 * output double-encodes the `steps` array; this eval caught it, so the planner moved to Opus 4.8 —
 * which uses the same tool-calling path, hence this eval verifies that path holds on Opus.)
 */

function anthropicKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      'planner-llm.eval: ANTHROPIC_API_KEY is not set. It must be present in .env.test.enc ' +
        '(loaded by ai-testing.config.ts) for the planner chain and the Haiku judge.',
    );
  }
  return key;
}

// Structural invariants the PLAN_SYSTEM prompt guarantees — must hold for EVERY case.
const wellFormed = scorer<PlanThreadInput, PlannedStep[]>({
  key: 'well-formed',
  threshold: 1,
  run: ({ output: steps }) => {
    const shapeOk =
      Array.isArray(steps) &&
      steps.length >= 1 &&
      steps.length <= 6 &&
      steps.every(
        (s) => typeof s.title === 'string' && s.title.trim() !== '' && typeof s.brief === 'string' && s.brief.trim() !== '',
      );
    if (!shapeOk) {
      return { key: 'well-formed', grade: 0, comment: `bad step shape: ${JSON.stringify(steps)?.slice(0, 200)}` };
    }
    // Last step must be a verification step (run the repo's own typecheck/build/tests).
    const last = `${steps[steps.length - 1].title} ${steps[steps.length - 1].brief}`.toLowerCase();
    const verifies = /\b(typecheck|type-check|build|tests?|lint|verif(y|ies|ication)|confirm)\b/.test(last);
    return verifies
      ? { key: 'well-formed', grade: 1 }
      : { key: 'well-formed', grade: 0, comment: `last step is not a verification step: "${steps[steps.length - 1].title}"` };
  },
});

// Delete-guard invariant — only for the 'delete-track' case: an early step must PROVE the
// target unused before any step removes it.
const deleteProvesUnused = scorer<PlanThreadInput, PlannedStep[]>({
  key: 'delete-proves-unused',
  threshold: 1,
  run: ({ output: steps, label }) => {
    if (label !== 'delete-track') return []; // skip other cases
    const text = (s: PlannedStep) => `${s.title} ${s.brief}`.toLowerCase();
    const provesIdx = steps.findIndex((s) =>
      /(unused|no (importers|callers|references|usages)|find (all )?(importers|callers|references|usages|referenc)|search for (references|usages|callers)|grep|dead code|prove .*(unused|not used)|nothing (imports|references|calls))/.test(
        text(s),
      ),
    );
    const removesIdx = steps.findIndex((s) => /\b(remove|delete|drop|deprecat)/.test(text(s)));
    if (provesIdx === -1) {
      return { key: 'delete-proves-unused', grade: 0, comment: 'no step proves the target is unused before removal' };
    }
    if (removesIdx !== -1 && provesIdx > removesIdx) {
      return {
        key: 'delete-proves-unused',
        grade: 0,
        comment: `prove-unused step (#${provesIdx + 1}) comes AFTER the removal step (#${removesIdx + 1})`,
      };
    }
    return { key: 'delete-proves-unused', grade: 1 };
  },
});

// Groundedness — is the plan a defensible decomposition of the brief that respects the locked
// decisions? Judged by a cheap Anthropic model (reuses ANTHROPIC_API_KEY, single-provider run).
const groundedness = llmJudge<PlanThreadInput, PlannedStep[]>({
  key: 'groundedness',
  threshold: 0.8,
  judge: new ChatAnthropic({ apiKey: anthropicKey(), model: 'claude-haiku-4-5-20251001', maxTokens: 1024 }),
  prompt: `You are grading Atlas's TRACK PLANNER. It turns one track of an approved feature into an
ordered list of implementation STEPS (each: a title + a concrete brief). It must respect the LOCKED
decision record and NOT re-litigate it.

The planner's inputs (feature overview, locked decisions, this track's brief, prior handoff):
<inputs>{inputs}</inputs>

The planner's output (the ordered steps):
<outputs>{outputs}</outputs>

Score TRUE if the plan is a defensible, coherent decomposition of THIS track's brief that:
- stays within the locked decisions (e.g. if a decision says "reuse Redis, no new infra" or "jsonb
  column, no new table", the steps must not introduce a new datastore/table);
- does NOT re-litigate or contradict a locked decision;
- has steps that are concrete and sequential (later steps build on earlier ones);
- ends with a verification step (runs the repo's own typecheck/build/tests);
- does NOT include a standalone "investigate the codebase" step (the repo is already investigated upstream).

Score FALSE only if the plan clearly violates a locked decision, is incoherent or misordered for the
brief, invents scope not implied by the brief, or omits verification. Allow reasonable judgment calls on
step granularity — do not penalize a plan for having one more or one fewer step than you would choose.`,
});

export default defineModule<PlanThreadInput, PlannedStep[]>({
  name: 'planner · track planner (Opus 4.8)',
  dataset: () => DATASET,
  runnable: () =>
    PlannerChains.planThread(
      new ChatAnthropic({
        apiKey: anthropicKey(),
        model: PlannerChains.MODEL,
        maxTokens: 4096,
      }),
    ),
  evaluators: [wellFormed, deleteProvesUnused, groundedness],
});
