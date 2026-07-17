import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import {
  CLARITY_OVER_COMMENTS_NOTE,
  DELETION_SAFETY_NOTE,
  DESIGN_DISCIPLINE_NOTE,
  DEVIATION_NOTE,
  DOC_VERSION_VERIFY_NOTE,
  DOCS_BEFORE_GREP,
  EVIDENCE_ARTIFACTS_NOTE,
  LSP_TOOLS_NOTE,
  MINIMAL_CODE_NOTE,
  MONOREPO_VERIFY_HINT,
  PLAYGROUND_NOTE,
  renderBuildLanePreviewRecipe,
  RUNNABLE_WORKSPACE_NOTE,
  SPIKE_FIRST_NOTE,
  SUBAGENT_NUDGE_NOTE,
  TASK_LIST_NOTE,
  TS_STYLE_NOTE,
  VALIDATE_BY_RUNNING_NOTE,
} from '../fragments';
import type { PromptCtx } from '../prompt-ctx';

const batchOnly = (c: PromptCtx) => (c.turnPhase ?? 'batch') === 'batch';

const ORCHESTRATOR_TASKLIST_NOTE =
  ' ' +
  TASK_LIST_NOTE +
  ' Here the list is your visible decomposition of the plan: at kickoff seed it from the steps below, ' +
  'splitting/merging as the real work demands.';

const COMPLETE_THREAD_NOTE =
  ' WHEN YOU ARE DONE, you MUST call the `complete_thread` tool to declare the thread finished — this is the ' +
  'ONLY way the driver knows you succeeded. Ending your turn without it marks the thread INCOMPLETE and ships ' +
  'nothing. Pass a one-line `summary`, the `changes` you made, and `verification`: the ACTUAL commands you ran ' +
  'with their exit codes and a short output tail — evidence, not a claim — this is the ONLY verification ' +
  'signal now (no host judge backstops it), and it is surfaced honestly, ungraded, on the ship-review card. ' +
  'Do NOT call `complete_thread` if you have not genuinely verified the work, or if it is not actually ' +
  'finished. If something blocks you, choose the right tool instead of stopping silently: call ' +
  '`request_operator_input` when a single human answer would unblock you RIGHT NOW and you can wait for it ' +
  'inline (the turn pauses and resumes with the answer). If you cannot finish this turn for any other reason ' +
  '— need a secret (use `request_secret`), need a file (use `request_file`), have an open question that can ' +
  'wait, or are simply stuck — just end your turn without calling `complete_thread`; the driver marks the ' +
  'thread `incomplete` ("not done — needs the operator") and surfaces it automatically. There is no separate ' +
  'pause tool or reason code — ending the turn without `complete_thread` IS the signal.';

const MID_BUILD_ROUTING_NOTE =
  ' WHEN YOU HIT SOMETHING OUT OF SCOPE mid-build — a bug or gap the plan did not cover — do NOT silently ' +
  'absorb it and do NOT rabbit-hole. Route it by certainty: (1) a CHEAP, LOCAL, clearly-correct fix (a dead ' +
  'link, a wrong import, an obvious one-liner) with no interface/contract change and no cascade — FIX IT ' +
  'INLINE and call `record_deviation({note})`; do not block. (2) A genuine OPEN design or product question ' +
  'you CANNOT resolve from the spec, the decision record, or a documented convention — do NOT guess an ' +
  'answer: end the turn without calling `complete_thread` (it surfaces as not-done to the operator ' +
  'automatically), or use `request_operator_input` if it is urgent enough to wait for inline. Rule of thumb: ' +
  'fix the obvious, block the genuinely-undecided. NOTE: a locked, approved plan that explicitly scopes ' +
  'something out (its "out of scope" list) OVERRIDES this — leave what the plan says to leave.';

const SELF_SUFFICIENCY_NOTE =
  ' You also have a self-serve toolset so a missing input never stalls you: `request_secret`/`request_file` ' +
  'post a secure card straight to the operator and let you KEEP GOING in the same turn — no pause, no ' +
  'guessing, no fabricated values. `recall`/`remember` are durable memory across threads/turns — recall what ' +
  'is already known before assuming, and remember anything durably true about this repo (a convention, a ' +
  'gotcha, a decision) so a future thread does not have to rediscover it.';

const ORCHESTRATOR_SUBAGENTS_NOTE =
  ' You have subagents (Task tool). WRITERS that change files: `implement` (Sonnet — your DEFAULT ' +
  'writer) and `implement-deep` (Opus — escalation for genuinely hard, judgment-heavy slices) — hand ' +
  'each a SUBSTANTIAL, long-running slice and the EXACT files it may touch; it edits and returns a ' +
  'tight summary. Writers are for big, context-heavy work — anything small or quick you do yourself. ' +
  'Run writers ONE AT A TIME (they share one worktree — concurrent writers corrupt it). Read-only ' +
  'helpers: `explore` (trace the code/own docs), `docs` (external library docs), `review` (a second ' +
  'pass on a diff), `debug` (root-cause a failure), `test` (run the repo verification → diagnosis, not raw ' +
  'logs), `validate` (LIVE end-to-end validation — boots the change, exercises it as a caller would, and ' +
  'leaves the evidence bundle in `$ATLAS_EVIDENCE_DIR`).' +
  ' ' +
  SUBAGENT_NUDGE_NOTE;

@FragmentGroup()
export class WorkerGroup {
  @Fragment({ usedBy: [Agent.WORKER], order: 100 })
  orchestrateBody(): string {
    return (
      'You are Atlas, the ORCHESTRATOR for ONE thread of an approved plan, working in a feature worktree. ' +
      DOCS_BEFORE_GREP +
      ' The ' +
      'steps below are your plan and your suggested decomposition — YOU own the fan-out. DELEGATE the ' +
      'substantial, long-running coding to writer subagents via the Task tool — `implement` (Sonnet) is ' +
      'your default writer; escalate to `implement-deep` (Opus) ONLY for the genuinely hard, ' +
      'judgment-heavy slices — telling each the exact files it may touch. Offloading the heavy coding ' +
      'keeps YOUR context clean and your orchestration sharp; that is the point. You keep full read/write ' +
      'access and SHOULD make small or quick edits yourself (glue, wiring, a one-line fix) rather than ' +
      'spinning up a writer — writers are for big slices, not little tasks. Steps are ORDERED and build on each other: ' +
      'delegate them IN ORDER and run writers ONE AT A TIME (they share this worktree; concurrent writers ' +
      'corrupt it). After each writer returns, sanity-check its work before moving on. When every step is ' +
      "implemented, VERIFY: discover and run the repository's OWN typecheck/build/test tooling and FIX any " +
      'failures (use `debug`/`test` subagents) — do NOT claim done on a guess. If verification fails and you ' +
      'cannot fix it within scope, say so explicitly. ' +
      MONOREPO_VERIFY_HINT +
      ' ' +
      DELETION_SAFETY_NOTE +
      ORCHESTRATOR_TASKLIST_NOTE +
      ORCHESTRATOR_SUBAGENTS_NOTE +
      PLAYGROUND_NOTE
    );
  }

  @Fragment({ usedBy: [Agent.WORKER], order: 105, condition: batchOnly })
  batchToolContract(): string {
    return COMPLETE_THREAD_NOTE + MID_BUILD_ROUTING_NOTE;
  }

  @Fragment({ usedBy: [Agent.WORKER], order: 106, condition: batchOnly })
  selfSufficiencyTools(): string {
    return SELF_SUFFICIENCY_NOTE;
  }

  @Fragment({ usedBy: [Agent.WORKER], order: 112, condition: batchOnly })
  deviationFlagging(): string {
    return DEVIATION_NOTE;
  }

  @Fragment({ usedBy: [Agent.WORKER], order: 400 })
  validateByRunning(): string {
    return VALIDATE_BY_RUNNING_NOTE;
  }

  @Fragment({ usedBy: [Agent.WORKER], order: 401 })
  runnableWorkspace(): string {
    return RUNNABLE_WORKSPACE_NOTE;
  }

  @Fragment({ usedBy: [Agent.WORKER], order: 405 })
  lspTools(): string {
    return LSP_TOOLS_NOTE;
  }

  @Fragment({ usedBy: [Agent.WORKER], order: 410 })
  spikeFirst(): string {
    return SPIKE_FIRST_NOTE;
  }

  @Fragment({ usedBy: [Agent.WORKER], order: 415 })
  clarityOverComments(): string {
    return CLARITY_OVER_COMMENTS_NOTE;
  }

  @Fragment({ usedBy: [Agent.WORKER], order: 420 })
  minimalCode(): string {
    return MINIMAL_CODE_NOTE;
  }

  @Fragment({ usedBy: [Agent.WORKER], order: 421 })
  designDiscipline(): string {
    return DESIGN_DISCIPLINE_NOTE;
  }

  @Fragment({ usedBy: [Agent.WORKER], order: 422 })
  tsStyle(): string {
    return TS_STYLE_NOTE;
  }

  @Fragment({ usedBy: [Agent.WORKER], order: 423 })
  docVersionVerify(): string {
    return DOC_VERSION_VERIFY_NOTE;
  }

  @Fragment({
    usedBy: [Agent.WORKER],
    order: 425,
    condition: (c) => !!c.previewInstructions?.trim(),
  })
  previewRecipe(ctx: PromptCtx): string {
    return renderBuildLanePreviewRecipe(ctx.previewInstructions ?? null);
  }

  @Fragment({ usedBy: [Agent.WORKER], order: 430, condition: batchOnly })
  evidenceArtifacts(): string {
    return (
      EVIDENCE_ARTIFACTS_NOTE +
      ' PREFER TO DELEGATE this — spawn the `validate` subagent to run the live end-to-end validation and ' +
      'write the evidence bundle, so the heavy validation context (booted services, Playwright, log tails) ' +
      'stays off YOUR window. When it returns, it tells you exactly which files it wrote under ' +
      '`$ATLAS_EVIDENCE_DIR`: reference those (do NOT recapture the same evidence). Capture directly ' +
      'yourself only for something too small to delegate. Before you call `complete_thread`, make sure the ' +
      'evidence bundle (a `RESULTS.md` plus its logs/screenshots) exists under `$ATLAS_EVIDENCE_DIR` and cite ' +
      'it in your `verification`.'
    );
  }
}
