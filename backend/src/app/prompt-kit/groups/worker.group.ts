/**
 * prompt-kit / groups / worker — the build/execute thread ORCHESTRATOR (`worker-orchestrate`). The unique
 * persona body is one fragment (order 100); the shared cloud-sandbox note + job-kind block come from
 * `DriverFramingGroup` (200/300); the behavioral layer (validate-by-running + spike) is the tail (400/410),
 * reproducing the legacy composer order `body → CLOUD_SANDBOX → jobKind → VALIDATE → SPIKE`.
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import {
  CLARITY_OVER_COMMENTS_NOTE,
  DELETION_SAFETY_NOTE,
  DEVIATION_NOTE,
  DOCS_BEFORE_GREP,
  LSP_TOOLS_NOTE,
  MONOREPO_VERIFY_HINT,
  PLAYGROUND_NOTE,
  SPIKE_FIRST_NOTE,
  TASK_LIST_NOTE,
  VALIDATE_BY_RUNNING_NOTE,
} from '../fragments';

// Orchestrator note — the LIVE task list: the shared discipline (TASK_LIST_NOTE) plus the orchestrator's own
// seeding rule — the list starts from the plan's steps.
const ORCHESTRATOR_TASKLIST_NOTE =
  ' ' +
  TASK_LIST_NOTE +
  ' Here the list is your visible decomposition of the plan: at kickoff seed it from the steps below, ' +
  'splitting/merging as the real work demands.';

// Orchestrator note — the TYPED TERMINAL ASSERTION (ADR 0004). The driver reads this tool call to decide the
// thread's outcome; ending the turn without it marks the thread INCOMPLETE and ships nothing.
const COMPLETE_THREAD_NOTE =
  ' WHEN YOU ARE DONE, you MUST call the `complete_thread` tool to declare the thread finished — this is the ' +
  'ONLY way the driver knows you succeeded. Ending your turn without it marks the thread INCOMPLETE and ships ' +
  'nothing. Pass a one-line `summary`, the `changes` you made, and `verification`: the ACTUAL commands you ran ' +
  'with their exit codes and a short output tail — evidence, not a claim. Do NOT call `complete_thread` if you ' +
  'have not genuinely verified the work, or if it is not actually finished. If a decision the plan does not ' +
  'cover blocks you, call `request_operator_input` (do not just stop).';

// Orchestrator note — the WRITER subagents (`implement`/`implement-deep`) alongside the read-only set.
const ORCHESTRATOR_SUBAGENTS_NOTE =
  ' You have subagents (Task tool). WRITERS that change files: `implement` (Sonnet — your DEFAULT ' +
  'writer) and `implement-deep` (Opus — escalation for genuinely hard, judgment-heavy slices) — hand ' +
  'each a SUBSTANTIAL, long-running slice and the EXACT files it may touch; it edits and returns a ' +
  'tight summary. Writers are for big, context-heavy work — anything small or quick you do yourself. ' +
  'Run writers ONE AT A TIME (they share one worktree — concurrent writers corrupt it). Read-only ' +
  'helpers: `explore` (trace the code/own docs), `docs` (external library docs), `review` (a second ' +
  'pass on a diff), `debug` (root-cause a failure), `test` (run the repo verification → diagnosis, not raw logs).';

@FragmentGroup()
export class WorkerGroup {
  /** The PER-THREAD ORCHESTRATOR persona: one Opus session owns the whole thread and fans the implementation
   *  out to writer subagents, integrating + verifying as it goes. */
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
      COMPLETE_THREAD_NOTE +
      ' ' +
      MONOREPO_VERIFY_HINT +
      ' ' +
      DELETION_SAFETY_NOTE +
      ' ' +
      DEVIATION_NOTE +
      ORCHESTRATOR_TASKLIST_NOTE +
      ORCHESTRATOR_SUBAGENTS_NOTE +
      PLAYGROUND_NOTE
    );
  }

  @Fragment({ usedBy: [Agent.WORKER], order: 400 })
  validateByRunning(): string {
    return VALIDATE_BY_RUNNING_NOTE;
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
}
