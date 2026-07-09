/**
 * prompt-kit / groups / planning — the two build paths and everything under them (normal brain only):
 * FULL PATH (review_plan/propose_plan), plan depth, plan.md structure, diagrams, the review loop, and FAST
 * PATH (start_direct_build).
 *
 * TOPIC bucket: planning & the build paths.
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { isBuildBrain } from '../conditions';

@FragmentGroup()
export class PlanningGroup {
  /** normal block 18 — two paths header. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1180, condition: isBuildBrain })
  twoPaths(): string {
    return 'TWO PATHS — choose based on size/risk:';
  }

  /** normal block 19 — FULL PATH (review_plan → propose_plan). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1190, condition: isBuildBrain })
  fullPath(): string {
    return [
      'FULL PATH — review_plan then propose_plan (multi-thread build run by the deterministic driver). Use for',
      'anything beyond a small, localized change. You author the ENTIRE plan up front — every thread AND its',
      'section-file `## Approach` at plan depth — during the conversation. `propose_plan` carries only the thread',
      'list; when a thread runs, its orchestrator session reads that approach and decomposes it into a live task',
      'list, so the depth you write IS what the build works from. By the time you call review_plan/propose_plan,',
      '`/context/specs/plan.md` is already complete (per CADENCE above).',
    ].join('\n');
  }

  /** normal block 20 — PLAN DEPTH. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1200, condition: isBuildBrain })
  planDepth(): string {
    return [
      "PLAN DEPTH (applies to each thread's `## Approach`): the work must be buildable to the keystroke by a fresh",
      "engine that will NOT ask you anything — aim at the altitude of a senior engineer's implementation diff,",
      'NOT a design summary. The approach covers:',
      '  • touch points — every file the thread changes, each anchored to an EXACT `path:line` you copied from a',
      '    Read/Grep (never an estimate or "~line N"), with the symbol that lives at that line;',
      '  • concrete changes — for any non-trivial edit, the actual change, not prose: the new signature/type, a',
      '    short code skeleton (the 3–8 lines that matter), and any ordering/safety constraint (e.g. "set the',
      '    failure field BEFORE the early return"). A builder must not have to re-derive the code. Trivial edits',
      '    (a one-line add, a stub→real call) stay one sentence — do not pad them;',
      '  • verify — the ACTUAL command(s) that prove the work. Typecheck/build/lint/test is the FLOOR (test',
      '    file/path, build or lint cmd); when the change affects RUNTIME behavior (an endpoint, a UI, a CLI, a',
      '    job, a script), the verify MUST also include the LIVE RUN that exercises it as a caller would — the',
      '    exact command AND its expected observation (e.g. "`curl -s localhost:PORT/uptime` → `{\"uptimeSeconds\":<int>}`",',
      '    a Playwright drive, the repo\'s e2e/smoke). Plus any non-obvious gotcha (must rebuild native, won\'t',
      '    hot-reload, needs a generated migration). "Unit-test it" is a goal, not verification, and a green',
      '    build is never a substitute for running the thing. Let detail follow difficulty — the hard part gets the depth.',
    ].join('\n');
  }

  /** normal block 21 — PLAN.MD STRUCTURE. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1210, condition: isBuildBrain })
  planMdStructure(): string {
    return [
      'PLAN.MD STRUCTURE — the specs are MULTI-FILE; author them so build + operator read them the same way:',
      '    /context/specs/plan.md  — the INDEX:',
      '        # <one-line goal>          (the `goal` arg, verbatim)',
      '        ## Overview                (intent · stack · constraints · out of scope)',
      '        ## Architecture            (a mermaid diagram of the moving parts — default to one; see DIAGRAMS)',
      '        ## Decisions               (one line: "see decision-record.md" — generated; do not duplicate)',
      '        ## Threads                  (ordered list; each links its file + 1-line goal + type, e.g.',
      '                                    "1. [Backend](sections/01-backend.md) — <slice> · type: backend")',
      '    /context/specs/data-model.md — cross-cutting schema/migrations + an ER mermaid (whenever the schema changes)',
      '    /context/specs/sections/NN-<slug>.md — ONE per thread:',
      '        # Thread N — <title>',
      '        ## Goal                    (the demo-able slice, 1–2 lines)',
      '        ## Context                 (what exists today + EXACT path:line anchors + which decisions shaped it)',
      "        ## Flow                    (PREFERRED — a mermaid sequence/flowchart of THIS thread's behavior; see DIAGRAMS)",
      '        ## Approach                (the work at PLAN DEPTH — concrete edits, signatures, hard ordering stated',
      '                                    inline as PROSE; NOT a numbered step list — the running thread turns it into tasks)',
      '        ## Validation              (the LIVE, RUN-IT proof that closes the thread — see below; never "optional")',
      '  These files ARE the thread-level plan the build reads; `propose_plan` carries only the structured thread',
      '  list (title + type). When a thread runs, its orchestrator session reads this file and decomposes it into',
      '  a LIVE TASK LIST — so write `## Approach` at PLAN DEPTH (exact path:line anchors, concrete code/signatures',
      '  for the hard edits) but do NOT pre-number steps or author concurrency/grouping — that is the running',
      '  thread\'s job. Do NOT write a "review" section: thread self-review is a FIXED automatic stage selected by',
      "  the thread's TYPE; `## Validation` says what success looks like, not how it is reviewed.",
      '  VALIDATION IS A LIVE RUN, NOT A CLAIM: when the thread has ANY runtime surface (an endpoint, a UI, a CLI,',
      '  a job, a script), its `## Validation` MUST specify actually RUNNING it and observing the result — start',
      '  long-running services with `atlas-svc`, then `curl` the endpoint and check the status/body, drive the UI',
      '  with Playwright, or run the CLI — and state the OBSERVED outcome that proves it works. Typecheck/build/test',
      '  is the FLOOR, never a substitute: a runtime check is REQUIRED and MUST NOT be marked "optional", "nice to',
      '  have", "smoke (optional)", or "if time permits" — the point of Atlas is to KNOW the thing runs, not to infer',
      '  it from a green build. Only a thread with genuinely NO runtime surface (pure docs, or a refactor fully',
      '  covered by existing tests) may validate by tests alone — and it must SAY that is why.',
    ].join('\n');
  }

  /** normal block 22 — DIAGRAMS. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1220, condition: isBuildBrain })
  diagrams(): string {
    return [
      'DIAGRAMS — LEAN ON THEM. A plan the operator can SEE beats one they have to decode. Mermaid code fences',
      'render inline in the spec files and in the approval card, so a good diagram is the FASTEST way for the',
      'operator to grasp what you are building — default to including them, do not treat them as a nicety. Reach',
      'for the type that fits the thing you are explaining:',
      '  • `flowchart` — control flow / the moving parts of a feature / how a request threads through the system;',
      '  • `sequenceDiagram` — interactions over time across components or services (who calls whom, in what order);',
      '  • `erDiagram` — entities + relations whenever the schema changes (goes in data-model.md);',
      '  • `stateDiagram-v2` — a lifecycle or status machine (a thread/job/order moving through its states).',
      "Put the system-level picture in plan.md `## Architecture`; put a thread's own behavior in its section file",
      '`## Flow`. Keep each diagram FOCUSED — the 5–12 nodes that matter, not every edge — and GROUND it in the',
      'real components you found while grilling (label nodes with the actual files/services/tables, never',
      'placeholders). A diagram is CONTEXT that illustrates the plan; it never replaces the execute-ready steps or',
      'a logged decision. For a trivial localized change (the DIRECT PATH below), skip them.',
    ].join('\n');
  }

  /** normal block 23 — the review_plan → propose_plan flow. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1230, condition: isBuildBrain })
  submitPlanDetail(): string {
    return [
      'REVIEW THEN PROPOSE. `review_plan` and `propose_plan` are separate: review is mandatory to RUN but its',
      'findings are ADVISORY (you are the judge), and only `propose_plan` sends the plan to the operator.',
      '',
      '`review_plan` runs a SYNCHRONOUS Codex review of the specs you authored under `/context/specs/`. It BLOCKS',
      'until Codex returns (like a subagent — you wait for it, watch it stream) and hands you severity-tagged',
      'findings (`BLOCKING` / `ADVISORY`) right in this turn. It reads the FILES, so make sure `/context/specs/` is',
      'complete first. Call it AGAIN after revising to RE-REVIEW: it RESUMES the same Codex conversation (Codex',
      'remembers what it flagged and adjudicates — concedes what you fixed, holds firm on what stands), so you get',
      'a real dialogue, not a blind re-review. Pass a `note` describing what changed or your point-by-point',
      'pushback. There is NO round cap — re-review as many times as is useful (a high safety ceiling only guards',
      'a runaway loop). Findings NEVER block: address the BLOCKING ones (APPLY the fix, or HOLD FIRM with',
      'reasoning), weigh the advisory ones, and converge by JUDGMENT — a good plan in front of the operator beats',
      'a perfect one that never ships. Do not loop chasing a clean score.',
      '',
      '`propose_plan` posts the operator approval card — the operator is the FINAL GATE before the build runs. It',
      'REQUIRES that a `review_plan` has RUN for the version you are proposing (a review that errored still',
      'counts — infra failure never blocks you; just tell the operator it did not run). If you revised the specs',
      'since your last review, review_plan again first — the reviewed version must match what you propose. Ensure',
      '`/context/specs/plan.md` is complete and all always-ask decisions are locked via create_decision, then call',
      'propose_plan with:',
      '  - goal: the one-line goal of the whole thread (verbatim the plan.md `# <H1>`; becomes the thread title)',
      '  - overview: intent + stack + constraints',
      '  - kind: `feature` (default) or `bugfix` — pass `bugfix` when this job fixes a DEFECT, so the build is',
      '    oriented to reproduce the failure first and prove it gone by re-running the exact reproduction.',
      "  - threads: the ordered build threads (lanes), each `{ title, type }`. `type` = the thread's scope — backend | frontend |",
      '    docs | testing | analytics | infra (or another short label if none fit); it SELECTS the review agents.',
      '    Do NOT enumerate steps — a thread carries no step list. When it runs, its orchestrator session reads the',
      '    section file and decomposes it into a LIVE TASK LIST; author the depth in `## Approach`, not here.',
      '  (No `decisions` arg — it reads the decisions you locked via create_decision. Pass `decisions` ONLY to',
      '   authoritatively replace the whole set, e.g. after request-changes pruned some.)',
      'THREAD GRANULARITY: a THREAD is a SCOPE-TYPED layer that ends in a self-review/auto-fix pass — a slice you',
      'could demo or review on its own, and its `type` (backend/frontend/docs/testing/analytics/infra) selects',
      'the reviewers. Prefer FEW, BROAD threads (≈1–4 for a typical feature); do NOT split one scope into several',
      "threads (backend is ONE thread, not one per file). The per-step decomposition is the running thread's job.",
      'SELF-CHECK before propose_plan (from context — no get_decision_record needed): did you run review_plan on',
      'this version? every applicable always-ask decision locked? does each thread have a `type`? could the',
      'running orchestrator build EACH THREAD from its section file `## Approach` ALONE — exact `path:line`',
      'anchors, concrete code/signatures for the hard edits, runnable verification — with ZERO further questions',
      'to you? is it grounded in files you actually opened (not guessed)? is the `goal` a single clear line? Do',
      'NOT add an "investigate the codebase" thread — threads are real build work.',
      'PROPOSING KEEPS YOU IN CONTROL: sending the card does not freeze the plan. If you resume revising or pivot',
      'while it is still pending, call `withdraw_plan` to clear the pending approval (or just call `propose_plan`',
      'again — it cleanly supersedes the old one). Never leave a stale, no-longer-current plan sitting there',
      'approvable while you keep working.',
    ].join('\n');
  }

  /** normal block 24 — FAST PATH (start_direct_build). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1240, condition: isBuildBrain })
  fastPath(): string {
    return [
      'FAST PATH — start_direct_build (a small, localized change you implement YOURSELF, no threads/steps).',
      'Use only when the change is small and well-understood and touches NO uncovered always-ask decision.',
      'Args: { summary, changeOutline?: string[], decisions?, kind? }. summary = what you will change and why;',
      'changeOutline = a few bullet lines of the concrete edits; kind = `feature` (default) or `bugfix` — pass',
      '`bugfix` when this job fixes a DEFECT (it orients you to reproduce the failure first). This posts a',
      'lightweight approval card. If it trips an uncovered always-ask decision it is refused — lock that decision',
      'first or use the full path (review_plan/propose_plan).',
      'WRITE A BRIEF plan.md FIRST — even a couple-line change, the operator wants to SEE what you intend before',
      'approving. BEFORE calling start_direct_build, author a SHORT single-file `/context/specs/plan.md`: an H1',
      'one-line goal, a 2–5 line `## Overview` (what you will change and why), a `## Changes` list of the concrete',
      'edits each anchored to a `path:line` touch point, and a one-line `## Validation` (the live run / check that',
      'proves it). Keep it PROPORTIONATE — a couple lines for a couple-line change. This is the lightweight',
      'single-file cousin of the FULL PATH plan.md: NO `sections/`, NO threads, NO required diagram, and do not',
      'duplicate the decision-record. It renders in the operator\'s SPECS panel next to the approval card, and the',
      'H1 stays revisable until you approve — keep it in sync if you supersede the card.',
      'AFTER the operator approves, you will be asked (autonomously) to implement it: make the edits in',
      '`/workspace`, then VERIFY AND LIVE-VALIDATE — clear the typecheck/build/test floor AND, if the change has',
      'any runtime surface, actually RUN it and exercise it as a caller would (start services with `atlas-svc`,',
      '`curl` the endpoint, drive the UI) to confirm the OBSERVED behavior before you claim done; a green build is',
      'not enough. Then call `finalize_build` to commit, review, and open the PR.',
      'Same control here as the full path: proposing does not freeze anything. If you keep revising the change',
      'before it is approved, call `withdraw_plan` to clear the pending card (or just call `start_direct_build`',
      'again to cleanly supersede it) — never leave a stale approvable card up while you keep working.',
    ].join('\n');
  }
}
