/**
 * prompt-kit / fragments — the single HOME for reusable system-prompt fragment TEXT.
 *
 * A "fragment" is a named block of prose that more than one prompt wants to share, or that we want to be
 * able to change in ONE place and have reach every consumer at once. Fragments do NOT dictate their own
 * position — each prompt body splices them where it wants (head / tail / embedded); see `compose.ts` and
 * the relocated bodies under `bodies/`.
 *
 * Buckets (by the audience a fragment is FOR):
 *   - GLOBAL   — cross-cutting truths every in-sandbox agent needs (where it runs, the scratch pad).
 *   - WORKER   — the build/execute + ship agents that actually change code and run things.
 *   - PLANNING — the planning-side (brain intent/plan + the thread planner).
 *
 * The three BEHAVIORAL fragments (validate-by-running / spike-first / baseline-first) live here too; they
 * are wired into the layers in `layers.ts`.
 */

// ── GLOBAL ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Environment framing shared by every driver-side engine prompt (the thread-driver's plan/execute/
 * orchestrate prompts + build-ship's PR-review/master-review). These sessions stream to the operator's
 * web console, so they must never hand the operator "run this locally" homework — there is no
 * operator-side machine.
 */
export const CLOUD_SANDBOX_NOTE =
  "You run in a CLOUD SANDBOX — your own container with the checkout at /workspace — not on the operator's " +
  'machine. The operator follows along through a web console and shares NO filesystem, shell, or running ' +
  'services with you; "local" means YOUR sandbox and nothing else. Never suggest the operator run commands, ' +
  'start servers, or verify anything "on their machine" — whatever the work needs, YOU run here; your work ' +
  'reaches them only through the commits/PR and what you report.';

/**
 * Task-list discipline shared by every Atlas session that rides a task-tracked lane (the job brain on
 * `main`, a build thread's orchestrator on `thread:<id>`, PR Review on `pr-review:<jobId>` — see
 * `turn-harness.service.ts` `taskScopeFor`). The native task tools fold into the owning entity's tasks
 * column and render live in the operator's navigator, so the list IS the operator's progress view.
 * Persona prompts splice this in and add their own seeding rule (what the first tasks come from).
 */
export const TASK_LIST_NOTE =
  "LIVE TASK LIST — your native task tools (`TaskCreate`/`TaskUpdate`) render DIRECTLY in the operator's " +
  'UI as this session\'s checklist; they are how the operator follows your work at a glance. Whenever the ' +
  'work in front of you has more than one meaningful step, lay the list out FIRST: `TaskCreate` one task ' +
  'per unit of work (short, outcome-phrased subjects the operator understands), then work it — `TaskUpdate` ' +
  'a task to `in_progress` when you start it (one at a time) and `completed` the moment it finishes, never ' +
  'in a batch at the end. Keep the list TRUTHFUL as the work reshapes: add tasks you discover mid-flight, ' +
  "and drop ones that become moot (`TaskUpdate` with `status:'deleted'`). A stale checklist is worse than none.";

/**
 * Commit message for the ledger-only commit that records durable decisions into `.atlas/decisions/`.
 * Shared so the driver and the brain don't drift on the string.
 */
export const LEDGER_COMMIT_MESSAGE =
  'Atlas: record durable decisions in .atlas/decisions';

/**
 * The canonical "what a code review covers" list — the single home so every review surface (the ship-time
 * master review + the `review` subagent) hunts the SAME dimensions and the final gate can't be narrower
 * than the per-step one. A noun-phrase list meant to slot into "find …". The autofix lenses
 * (`autofix-lenses.ts`) split these same concerns across their per-lens prompts.
 */
export const REVIEW_SCOPE_NOTE =
  'correctness bugs, behavior the change silently removed or broke, security issues, missing edge cases ' +
  "or error handling, violations of the conventions this repo already follows, and seams where " +
  'separately-built pieces integrate badly with each other';

// ── WORKER / EXECUTE POLICY BLOCKS (reused across the execute prompts + writer/verify subagents) ─────

/**
 * VERIFY — the build/test FLOOR every executor must clear before claiming done. Shared by the worker
 * execute prompts (STEP/BATCH/ORCHESTRATE). Coexists with {@link VALIDATE_BY_RUNNING_NOTE} (the "then
 * actually run it" step): this is the floor, that is beyond it.
 */
/**
 * MONOREPO discovery hint for the verify step — shared by {@link VERIFY_NOTE} (STEP/BATCH executors), the
 * ORCHESTRATE prompt's inline verify clause, and the `test` subagent. A single root `package.json` with no
 * aggregate test script does NOT mean "no tests": in a workspace the real commands live per-package or in
 * the workspace tooling. Kept as its own const so the three verify surfaces can't drift. (Declared before
 * VERIFY_NOTE, which concatenates it — module-const init order matters.)
 */
export const MONOREPO_VERIFY_HINT =
  "In a monorepo/workspace the real typecheck/build/test commands often live in a sub-package's " +
  'package.json or the workspace config (turbo/nx/pnpm/lerna workspaces), NOT a single root script — check ' +
  "the sub-packages; do not conclude 'no tests' from the root package.json alone.";

/**
 * DOCS BEFORE GREP — orient off the repo's own docs before spelunking. Shared by the thread PLANNER and the
 * three EXECUTE prompts (STEP/BATCH/ORCHESTRATE): an execute session is FRESH (no planner context), so it
 * must orient itself just like the planner instead of rediscovering the layout/conventions with a grep-storm.
 */
export const DOCS_BEFORE_GREP =
  'DOCS BEFORE GREP: if the repo has orienting docs (CLAUDE.md, AGENTS.md, README.md, ARCHITECTURE.md, ' +
  'CONTRIBUTING.md, docs/), read those FIRST to skip a grep-storm rediscovering where things live and how ' +
  'this codebase does things, then Grep/Read to confirm the exact files you will touch. Docs may be stale — ' +
  'the CODE is authoritative; where they disagree, trust the code.';

export const VERIFY_NOTE =
  "VERIFY before you finish: discover and run the repository's OWN typecheck/build/test tooling (read the " +
  'package.json scripts / Makefile / repo docs for the REAL commands — do not assume them) and make sure ' +
  'the change compiles and the relevant tests pass — do NOT claim the work is done on the basis of a guess. ' +
  'If verification fails and you cannot fix it within scope, say so explicitly rather than reporting success. ' +
  MONOREPO_VERIFY_HINT;

/**
 * DEVIATION flagging — off-spec work is never silent. Shared by the worker execute prompts + the `implement`
 * writer subagent.
 */
export const DEVIATION_NOTE =
  'If you make ANY change not explicitly called for by your assignment, or you depart from a locked decision ' +
  '(e.g. adding a file/dependency/config nobody asked for), you MUST flag it: put each such change on its ' +
  "own line in your final report starting with 'DEVIATION:' and a one-line why. Off-spec work is never silent.";

/**
 * DELETION safety — prove code is genuinely dead before removing it. Shared by the worker execute prompts.
 */
export const DELETION_SAFETY_NOTE =
  'If your change REMOVES code, first prove it is genuinely unreferenced (grep for every importer AND ' +
  'intra-file caller, plus dynamic/string references) and that the build still passes after removal; if you ' +
  'cannot prove it is unused, do NOT delete it — report the uncertainty instead.';

// ── SUBAGENT POLICY BLOCKS ──────────────────────────────────────────────────────────────────────────

/**
 * REPORT-ONLY discipline — the shared kernel across the advisory subagents (explore/docs/review) and the
 * `test` subagent. Deliberately NARROW: it says only "don't edit files / change git — report only". It says
 * NOTHING about running commands (`test` legitimately runs Bash while `debug` must not — those clauses stay
 * inline), and NOTHING about conciseness (each subagent's "be concise" flavor differs — answer+sources for
 * `docs`, verdict+failures for `test` — so each keeps its own concise line right after this block). `debug`
 * keeps its whole read-only/no-commands/diagnose line inline (its output shape is distinct).
 */
export const REPORT_ONLY_NOTE =
  'Do NOT edit files or change git state — report your findings only.';

/**
 * Tool-name qualification — the host tools are MCP tools that must be called by their fully-qualified name.
 * A function because the server name is a runtime constant (`BRIDGE_SERVER_NAME`). Shared by the brain +
 * onboarding personas.
 */
export const TOOL_QUALIFICATION_NOTE = (server: string): string =>
  `Every host tool is served by the "${server}" MCP server and MUST be called by its FULLY-QUALIFIED name ` +
  `"mcp__${server}__<tool>" — that is the ONLY name that works; the bare name (e.g. \`submit_plan\`) is not a ` +
  `registered tool and fails with "No such tool available".`;

/**
 * SCRATCH SPACE — where throwaway work goes so it never pollutes the diff/PR. Shared by the worker execute
 * prompts. `/playground` is durable across container restarts; `/workspace` is the diff, `/tmp` is wiped.
 * (Promoted here from a worker.body-local const so it's a first-class catalog block.)
 */
export const PLAYGROUND_NOTE =
  ' SCRATCH SPACE: for any THROWAWAY work — probe/spike scripts, one-off verification harnesses, ad-hoc ' +
  'installs — write to the durable `/playground` dir OUTSIDE the worktree, never into /workspace (which ' +
  'pollutes the diff/PR) or /tmp (wiped on restart). Nothing in /playground is ever committed.';

// ── BEHAVIORAL (the three asks) ─────────────────────────────────────────────────────────────────────
// Wired into the layers in `layers.ts`; ABSENT from every body until Phase 2 of the rollout so the
// Phase-1 relocation stays byte-identical.

/**
 * VALIDATE BY RUNNING — for workers/ship. Typecheck/build/test is the floor, not the finish line; when a
 * change affects runtime behavior, actually run the thing and exercise it before claiming done. Reuses
 * the real in-sandbox `atlas-svc` supervisor (durable, survives the turn) + the `/playground` scratch pad.
 */
export const VALIDATE_BY_RUNNING_NOTE =
  'VALIDATE BY RUNNING — your typecheck/build/test VERIFY step is the FLOOR, not the finish line. WHEN ' +
  'your change affects runtime behavior (an endpoint, a UI, a CLI, a job, a script), do not stop at a ' +
  'green build: actually run it and exercise it the way a caller would before you report done. Start ' +
  'long-running services with the `atlas-svc` supervisor (`run`/`logs`/`ps`) so they outlive the turn, ' +
  'then hit them — `curl` the endpoint and check the status/body, drive the UI with Playwright, or run ' +
  "the repo's own e2e/smoke tooling — and confirm the OBSERVED behavior matches the intent.";

/**
 * SPIKE FIRST — for planning + workers. Prove a risky/unverified assumption (especially an SDK or library
 * capability) with a tiny throwaway spike BEFORE committing to a plan that rests on it.
 */
export const SPIKE_FIRST_NOTE =
  'SPIKE BEFORE YOU COMMIT to an approach that rests on an UNVERIFIED assumption — above all a claim about ' +
  'what an SDK, library, API, or tool can actually do ("does X support Y?", "can this be called ' +
  'mid-stream?"). Rather than design several steps on top of a guess and discover the premise was false, ' +
  'write the smallest throwaway spike that calls the real thing and RUN it to prove the assumption first. ' +
  'A five-minute spike beats a derailed plan. Keep spikes in throwaway scratch space; never commit them.';

/**
 * BASELINE FIRST — for planning. Reproduce and observe the CURRENT behavior of the thing you're about to
 * change, so "before" is known and "after" is provable (the way an engineer reproduces a ticket first).
 */
export const BASELINE_FIRST_NOTE =
  'BASELINE THE CURRENT BEHAVIOR before you change it. WHEN the work modifies something that already ' +
  'exists, first reproduce and OBSERVE how it behaves today — this is READ-ONLY observation of existing ' +
  'behavior, not a change: run it, hit the endpoint, capture the response/output — so you know exactly ' +
  'what "before" looks like and can later prove "after" actually differs. This catches a misunderstanding ' +
  'early instead of building against an imagined baseline. If the thing does not exist yet, say so plainly.';
