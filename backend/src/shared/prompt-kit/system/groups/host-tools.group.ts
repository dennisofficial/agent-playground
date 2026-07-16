/**
 * prompt-kit / groups / host-tools — the host MCP tool surface: the fully-qualified tool list, the flat
 * top-level calling convention, and the create_job tool; plus the onboarding session's curated tool list.
 *
 * TOPIC bucket: host tools. Interpolates the runtime `BRIDGE_SERVER_NAME` and reuses the shared
 * `TOOL_QUALIFICATION_NOTE` catalog block.
 */
import { Agent, ENGINEERING_STAGES } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import {
  isAtlasRepo,
  isBuildBrain,
  isOnboarding,
  isReview,
  notOnboarding,
} from '../conditions';
import { BRIDGE_SERVER_NAME } from '../../../bridge-names/bridge-options';
import { WORKSPACE_PROFILE_BRIDGE_NAME } from '../../../bridge-names/workspace-profile-bridge-options';
import { ATLAS_PROD_BRIDGE_NAME } from '../../../bridge-names/atlas-prod-bridge-options';
import { LSP_TOOLS_NOTE, TOOL_QUALIFICATION_NOTE } from '../fragments';

@FragmentGroup()
export class HostToolsGroup {
  /** The host tools — qualification + enumeration + ambient capability tools. */
  @Fragment({
    usedBy: [Agent.PLANNING],
    order: 1040,
    condition: isBuildBrain,
  })
  hostTools(): string {
    return [
      `You have the host tools listed below. ${TOOL_QUALIFICATION_NOTE(BRIDGE_SERVER_NAME)}`,
      `The prose below abbreviates these to short names for readability, but you must call the`,
      `mcp__${BRIDGE_SERVER_NAME}__ form. Your host tools:`,
      `  - mcp__${BRIDGE_SERVER_NAME}__ask_question         — ask the operator one focused question (renders as a card; you may have several open at once; see GRILLING)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__withdraw_question    — retract a still-unanswered question BY questionId (to reword it or if it's now moot; never re-ask an open one — see the <open-questions> turn header)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__create_decision      — lock an always-ask decision (attaches the answered question — pass questionId to name which one, else the one just answered; set confirmedByOperator when the operator chose it, see GRILLING); returns its stable id`,
      `  - mcp__${BRIDGE_SERVER_NAME}__update_decision      — revise a locked decision BY ID (ruling/title/class)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__set_job_kind         — classify THIS job's kind ('feature'|'bugfix'|'review') when it isn't a build you're scoping — e.g. a PR review. Reflected in your orientation from the next turn. (feature/bugfix are normally carried by propose_plan/start_direct_build; use this for 'review' or to re-classify.)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__delete_decision      — drop a locked decision BY ID`,
      `  - mcp__${BRIDGE_SERVER_NAME}__get_pipeline_state   — read the current job/pipeline state for this thread`,
      `  - mcp__${BRIDGE_SERVER_NAME}__get_decision_record  — read back the locked decisions (RECOVERY ONLY — see below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__recall               — retrieve relevant memory facts (semantic search)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__remember             — store a new memory fact`,
      `  - mcp__${BRIDGE_SERVER_NAME}__forget               — soft-delete a stored memory by id (from a recall/harness [id])`,
      `  - mcp__${BRIDGE_SERVER_NAME}__update_memory        — rewrite a stored memory fact by id (re-embeds)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__review_plan          — run (or resume) a SYNCHRONOUS Codex review of your authored specs; returns severity-tagged findings (FULL PATH; see below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__propose_plan         — send the reviewed plan to the operator for approval (FULL PATH; requires review_plan first; see below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__withdraw_plan        — retract a still-pending plan/direct-build approval you proposed (flips back to planning; the operator's Approve button clears). Use it when you keep working after proposing; then re-propose when ready.`,
      `  - mcp__${BRIDGE_SERVER_NAME}__withdraw_ship        — PROPOSE amending the READY-TO-SHIP build: posts an "Amend build?" card for the operator. It does NOT retract the gate — only the operator can, by approving. After proposing, STOP and wait; if approved you'll be re-woken to do the work. Frame your reason as YOUR OWN recommendation (never "Operator wants…"). Keeps completed work; the gate re-arms once follow-up work lands.`,
      `  - mcp__${BRIDGE_SERVER_NAME}__start_direct_build   — propose a small change you will implement yourself (FAST PATH; see below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__finalize_build       — (gated) ship an approved direct build: commit → review → open PR`,
      `  - mcp__${BRIDGE_SERVER_NAME}__dispatch_build       — (gated) start the approved build after the base-check`,
      `  - mcp__${BRIDGE_SERVER_NAME}__hold_build           — (gated) hold the build & return to planning if the rebased base invalidates the plan`,
      `  - mcp__${BRIDGE_SERVER_NAME}__create_job           — spin off a NEW job on this same repo; optionally born blocked with dependsOn (see CREATE_JOB below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__list_jobs            — list this repo's sibling jobs to discover ids for peer dependencies (see CREATE_JOB below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__link_job_dependency  — explicitly mark one existing same-repo job as blocked by another`,
      `You ALSO have these AMBIENT capability tools — usable ANY turn, whenever the work hits the friction they solve (see ENVIRONMENT GAPS below):`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__request_secret       — securely request a missing SECRET VALUE from the operator (stored encrypted, rendered to a path; persists for future jobs). You may keep SEVERAL open at once (like request_file) — no need to wait one at a time`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__request_file         — have the operator UPLOAD a whole file/key (env file, service-account JSON, .pem; encrypted, granted to a gitignored path); several may be open at once`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__withdraw_file_request — retract a still-open request_file card BY requestId (wrong path / no longer needed); post a corrected request_file if you still need the file`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__withdraw_secret_request — retract a still-open request_secret card BY requestId (wrong target / no longer needed); post a corrected request_secret if you still need it`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__derive_secret        — store a value YOU computed from an already-granted credential (no operator wait; e.g. a printed webhook secret)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__write_workspace_config — amend the repo's DB-backed workspace config (mounts) — a live write for every future job on this repo, no PR`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__write_setup_script   — save the repo's cold-boot setup script ({ script }) — idempotent commands that ARM the box (install/build/index), NOT ones that start runtime services (docker/DB/app server — those are on-demand per turn); runs on EVERY cold sandbox bring-up for every future job on this repo (no PR). It REPLACES the whole script — read_setup_script FIRST to see the current body`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__read_setup_script    — read the repo's CURRENT cold-boot setup script (raw body) so you can edit it safely before write_setup_script (which overwrites the whole thing)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__write_preview_instructions — save the repo's PREVIEW RECIPE ({ instructions }) — how to stand up this repo's demo-ready preview stack (envs, ports, compose/migrate/seed, deep-link); injected into the "Spin up preview" seed for every job on this repo (no PR). It REPLACES the whole recipe — read_preview_instructions FIRST to see the current body`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__read_preview_instructions  — read the repo's CURRENT preview recipe (raw body) so you can edit it safely before write_preview_instructions (which overwrites the whole thing)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__reset_sandbox        — recreate your container from scratch to prove the setup cold-boots (recreates on your NEXT turn — call it, then STOP). Add { hard:true } for a full from-scratch reset (fresh worktree + container, session kept) — two-call confirm; refuses on a dirty/unpushed tree`,
    ].join('\n');
  }

  /** The POST_BUILD/CI curated host tools (orders 1042/1043: unique vs hostTools@1040/reviewTools@1041, and
   *  from EACH OTHER since each fragment now targets its own single agent, not the shared `SHIP_STAGES`
   *  audience). Both stages lose the PLANNING-only `hostTools()` catalog above IN FULL — no
   *  ask_question/withdraw_question (grill), no create_decision/update_decision/delete_decision/
   *  get_decision_record, no review_plan/propose_plan/withdraw_plan/dispatch_build/hold_build/
   *  start_direct_build/finalize_build/set_job_kind/propose_convention_profile_change — that whole apparatus
   *  belongs to PLANNING, the plan-author/approver they were split off from. Both stages ACT (verify a fix,
   *  amend), they don't plan. Mirroring `reviewTools()`/`onboardingTools()`, each gets its own qualification
   *  note + curated list so the `mcp__` calling convention and the ambient capability tools (referenced
   *  bare-name elsewhere, e.g. `cloudSandbox()`, `environmentGaps()`, `atlasSvc()`, `createJob()`) are
   *  actually documented for them. `withdraw_ship` is POST_BUILD-only: it owns the amend loop; CI does not,
   *  and does not get the tool registered (see `buildTools` in agent-session-manager.service.ts) — CI owns
   *  PR creation/maintenance directly via `gh`/git (Bash), not a host tool. */
  @Fragment({
    usedBy: [Agent.POST_BUILD],
    order: 1042,
    condition: isBuildBrain,
  })
  postBuildTools(): string {
    return [
      `You have the host tools listed below. ${TOOL_QUALIFICATION_NOTE(BRIDGE_SERVER_NAME)}`,
      'Call every host tool with its fields DIRECTLY at the top level (no `args` wrapper). This is the',
      'ship-review GATE, not the planning brain — you have NO grilling or plan-authoring/plan-review tools,',
      'and no decision-record tools, this session. You ACT: make the fix, or amend the build. Your host',
      'tools this session:',
      `  - mcp__${BRIDGE_SERVER_NAME}__get_pipeline_state   — read the current job/pipeline state for this thread`,
      `  - mcp__${BRIDGE_SERVER_NAME}__recall               — retrieve relevant memory facts (semantic search)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__remember             — store a new memory fact`,
      `  - mcp__${BRIDGE_SERVER_NAME}__withdraw_ship        — PROPOSE amending the READY-TO-SHIP build: posts an "Amend build?" card for the operator. It does NOT retract the gate — only the operator can, by approving. After proposing, STOP and wait; if approved you'll be re-woken to do the work. Frame your reason as YOUR OWN recommendation (never "Operator wants…"). Keeps completed work; the gate re-arms once follow-up work lands.`,
      `  - mcp__${BRIDGE_SERVER_NAME}__create_job           — spin off a NEW job on this same repo; optionally born blocked with dependsOn (see CREATE_JOB below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__list_jobs            — list this repo's sibling jobs to discover ids for peer dependencies (see CREATE_JOB below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__link_job_dependency  — explicitly mark one existing same-repo job as blocked by another`,
      `You ALSO have these AMBIENT capability tools — usable ANY turn, whenever the work hits the friction they solve (see ENVIRONMENT GAPS below):`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__request_secret       — securely request a missing SECRET VALUE from the operator (stored encrypted, rendered to a path; persists for future jobs). You may keep SEVERAL open at once (like request_file) — no need to wait one at a time`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__request_file         — have the operator UPLOAD a whole file/key (env file, service-account JSON, .pem; encrypted, granted to a gitignored path); several may be open at once`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__withdraw_file_request — retract a still-open request_file card BY requestId (wrong path / no longer needed); post a corrected request_file if you still need the file`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__withdraw_secret_request — retract a still-open request_secret card BY requestId (wrong target / no longer needed); post a corrected request_secret if you still need it`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__derive_secret        — store a value YOU computed from an already-granted credential (no operator wait; e.g. a printed webhook secret)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__write_workspace_config — amend the repo's DB-backed workspace config (mounts) — a live write for every future job on this repo, no PR`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__write_setup_script   — save the repo's cold-boot setup script ({ script }) — idempotent commands that ARM the box (install/build/index), NOT ones that start runtime services (docker/DB/app server — those are on-demand per turn); runs on EVERY cold sandbox bring-up for every future job on this repo (no PR). It REPLACES the whole script — read_setup_script FIRST to see the current body`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__read_setup_script    — read the repo's CURRENT cold-boot setup script (raw body) so you can edit it safely before write_setup_script (which overwrites the whole thing)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__write_preview_instructions — save the repo's PREVIEW RECIPE ({ instructions }) — how to stand up this repo's demo-ready preview stack (envs, ports, compose/migrate/seed, deep-link); injected into the "Spin up preview" seed for every job on this repo (no PR). It REPLACES the whole recipe — read_preview_instructions FIRST to see the current body`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__read_preview_instructions  — read the repo's CURRENT preview recipe (raw body) so you can edit it safely before write_preview_instructions (which overwrites the whole thing)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__reset_sandbox        — recreate your container from scratch to prove the setup cold-boots (recreates on your NEXT turn — call it, then STOP). Add { hard:true } for a full from-scratch reset (fresh worktree + container, session kept) — two-call confirm; refuses on a dirty/unpushed tree`,
    ].join('\n');
  }

  /** The CI curated host tools (order 1043). Same as `postBuildTools()` minus `withdraw_ship` — CI does not
   *  own the amend loop; it owns PR creation/maintenance directly via `gh`/git (Bash), not a host tool. */
  @Fragment({ usedBy: [Agent.CI], order: 1043, condition: isBuildBrain })
  ciTools(): string {
    return [
      `You have the host tools listed below. ${TOOL_QUALIFICATION_NOTE(BRIDGE_SERVER_NAME)}`,
      'Call every host tool with its fields DIRECTLY at the top level (no `args` wrapper). This is a',
      'post-ship PR-lifecycle stage, not the planning brain — you have NO grilling or plan-authoring/',
      'plan-review tools, and no decision-record tools, this session. You ACT: maintain the PR directly via',
      'git/gh. Your host tools this session:',
      `  - mcp__${BRIDGE_SERVER_NAME}__get_pipeline_state   — read the current job/pipeline state for this thread`,
      `  - mcp__${BRIDGE_SERVER_NAME}__recall               — retrieve relevant memory facts (semantic search)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__remember             — store a new memory fact`,
      `  - mcp__${BRIDGE_SERVER_NAME}__create_job           — spin off a NEW job on this same repo; optionally born blocked with dependsOn (see CREATE_JOB below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__list_jobs            — list this repo's sibling jobs to discover ids for peer dependencies (see CREATE_JOB below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__link_job_dependency  — explicitly mark one existing same-repo job as blocked by another`,
      `You ALSO have these AMBIENT capability tools — usable ANY turn, whenever the work hits the friction they solve (see ENVIRONMENT GAPS below):`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__request_secret       — securely request a missing SECRET VALUE from the operator (stored encrypted, rendered to a path; persists for future jobs). You may keep SEVERAL open at once (like request_file) — no need to wait one at a time`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__request_file         — have the operator UPLOAD a whole file/key (env file, service-account JSON, .pem; encrypted, granted to a gitignored path); several may be open at once`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__withdraw_file_request — retract a still-open request_file card BY requestId (wrong path / no longer needed); post a corrected request_file if you still need the file`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__withdraw_secret_request — retract a still-open request_secret card BY requestId (wrong target / no longer needed); post a corrected request_secret if you still need it`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__derive_secret        — store a value YOU computed from an already-granted credential (no operator wait; e.g. a printed webhook secret)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__write_workspace_config — amend the repo's DB-backed workspace config (mounts) — a live write for every future job on this repo, no PR`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__write_setup_script   — save the repo's cold-boot setup script ({ script }) — idempotent commands that ARM the box (install/build/index), NOT ones that start runtime services (docker/DB/app server — those are on-demand per turn); runs on EVERY cold sandbox bring-up for every future job on this repo (no PR). It REPLACES the whole script — read_setup_script FIRST to see the current body`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__read_setup_script    — read the repo's CURRENT cold-boot setup script (raw body) so you can edit it safely before write_setup_script (which overwrites the whole thing)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__write_preview_instructions — save the repo's PREVIEW RECIPE ({ instructions }) — how to stand up this repo's demo-ready preview stack (envs, ports, compose/migrate/seed, deep-link); injected into the "Spin up preview" seed for every job on this repo (no PR). It REPLACES the whole recipe — read_preview_instructions FIRST to see the current body`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__read_preview_instructions  — read the repo's CURRENT preview recipe (raw body) so you can edit it safely before write_preview_instructions (which overwrites the whole thing)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__reset_sandbox        — recreate your container from scratch to prove the setup cold-boots (recreates on your NEXT turn — call it, then STOP). Add { hard:true } for a full from-scratch reset (fresh worktree + container, session kept) — two-call confirm; refuses on a dirty/unpushed tree`,
    ].join('\n');
  }

  /** The atlas-prod host tools — ONLY present on the Atlas repo itself. The 7 read tools mirror the
   *  prod-diagnostics reader; propose_prod_write is a STRUCTURALLY-GATED write (propose-only). */
  @Fragment({ usedBy: ENGINEERING_STAGES, order: 1044, condition: isAtlasRepo })
  atlasProdTools(): string {
    return [
      `You are on the Atlas repo itself, so you ALSO have the atlas-prod tools — read-only production diagnostics plus a STRUCTURALLY-GATED prod DB write. Call the mcp__${ATLAS_PROD_BRIDGE_NAME}__ form:`,
      `  - mcp__${ATLAS_PROD_BRIDGE_NAME}__atlas_query         — run ONE read-only SELECT/WITH against the prod DB`,
      `  - mcp__${ATLAS_PROD_BRIDGE_NAME}__atlas_schema        — list prod tables + columns`,
      `  - mcp__${ATLAS_PROD_BRIDGE_NAME}__atlas_job_overview  — a job's status + thread list`,
      `  - mcp__${ATLAS_PROD_BRIDGE_NAME}__atlas_session_raw   — raw Claude session JSONL for a job`,
      `  - mcp__${ATLAS_PROD_BRIDGE_NAME}__atlas_context_read  — a job's /context dir tree or a file`,
      `  - mcp__${ATLAS_PROD_BRIDGE_NAME}__atlas_worktree_tree — a job's git worktree tree`,
      `  - mcp__${ATLAS_PROD_BRIDGE_NAME}__atlas_worktree_file — one file from a job's worktree`,
      `  - mcp__${ATLAS_PROD_BRIDGE_NAME}__propose_prod_write  — PROPOSE a single-statement prod DB write (INSERT/UPDATE/DELETE/WITH). You can only PROPOSE: the statement is previewed and an operator must approve it on a card before ANYTHING executes. Nothing you propose runs unapproved. Single statement only; no DDL/schema changes.`,
    ].join('\n');
  }

  /**
   * The LSP tools (`atlas-lsp-ts`, a SEPARATE MCP server from the host bridge above;
   * the SDK spawns it directly, no host round-trip). Unlike the host-bridge tools, these carry real,
   * specific descriptions from mcp-language-server's own tool registration, so — unlike `hostTools()`
   * above — there is no need to hand-enumerate what each one does here; just the behavioral nudge.
   */
  @Fragment({
    usedBy: ENGINEERING_STAGES,
    order: 1045,
    condition: notOnboarding,
  })
  lspTools(): string {
    return LSP_TOOLS_NOTE;
  }

  /** The flat top-level calling convention. */
  @Fragment({
    usedBy: ENGINEERING_STAGES,
    order: 1050,
    condition: notOnboarding,
  })
  argsWrapper(): string {
    return [
      'ARGUMENTS — call every host tool with its fields DIRECTLY at the top level, exactly as the tool',
      'schema declares them. The shorthand below (e.g. `create_decision({ decisionClass, ruling })`) is',
      'LITERAL — pass those fields as-is. Do NOT nest them under an `args` object: each tool is registered',
      'with its own strict per-field shape, so an `args` wrapper is an unknown key that gets stripped, the',
      'call then arrives EMPTY (the required fields read as undefined) and fails.',
    ].join('\n');
  }

  /** create_job — spin off a follow-up thread, optionally born blocked on same-repo blockers. */
  @Fragment({
    usedBy: ENGINEERING_STAGES,
    order: 1060,
    condition: isBuildBrain,
  })
  createJob(): string {
    return [
      'CREATE_JOB — when the work splits into a separate unit of its own, create a follow-up thread rather',
      'than overloading this one. Args: { title, firstMessage, dependsOn? }. `firstMessage` is the opening',
      'intent the new thread starts on (write it as you would brief a fresh session). By default the new job',
      'starts scoping immediately and independently. If it explicitly needs another SAME-REPO job to land',
      'first, pass dependsOn: jobId or jobId[] and it is born BLOCKED; its brain will not run until every',
      'blocker resolves. Dependencies are explicit only — never assume an out-of-scope follow-up depends on',
      'the current job unless that is actually required. BEFORE wiring any peer dependency, call list_jobs to',
      'discover the real same-repo job ids (you cannot invent them) — then wire it in whichever direction is',
      'true: if the NEW job must wait on an existing in-flight job, pass dependsOn; if an EXISTING job should',
      'wait on this new one, create the new job first, then call link_job_dependency to block the existing',
      'job on it. Only do this when the operator asked for a follow-up or the split is clearly warranted —',
      'one tightly-scoped follow-up per call, not a backlog.',
    ].join('\n');
  }

  /** The onboarding session's curated host tools. */
  @Fragment({
    usedBy: [Agent.PLANNING],
    order: 2050,
    condition: isOnboarding,
  })
  onboardingTools(): string {
    return [
      TOOL_QUALIFICATION_NOTE(BRIDGE_SERVER_NAME),
      'Call every host tool with its fields DIRECTLY at the top level — do NOT wrap them in an `args`',
      'object (e.g. request_secret({ name, path, description }), NOT request_secret({ args: { … } })).',
      'Your host tools this session:',
      `  - mcp__${BRIDGE_SERVER_NAME}__ask_question        — ask/verify ONE thing with the operator (renders as a card)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__withdraw_question   — retract a still-unanswered question BY questionId (reword/moot; never re-ask an open one)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__recall              — retrieve relevant memory facts`,
      `  - mcp__${BRIDGE_SERVER_NAME}__remember            — store a durable memory fact about this repo`,
      `  - mcp__${BRIDGE_SERVER_NAME}__forget              — soft-delete a stored memory by id (from a recall/harness [id])`,
      `  - mcp__${BRIDGE_SERVER_NAME}__update_memory       — rewrite a stored memory fact by id (re-embeds)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__list_jobs           — list this repo's sibling jobs to discover ids for peer dependencies (call this before wiring a dependency)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__create_job          — spin off a NEW job on this same repo; optionally born blocked with dependsOn`,
      `  - mcp__${BRIDGE_SERVER_NAME}__link_job_dependency — mark one existing same-repo job as blocked by another`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__request_secret      — securely ask the operator for a SECRET VALUE (see SECRETS); several may be open at once, like request_file`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__request_file        — ask the operator to UPLOAD a file (JSON/key file; see SECRETS); several may be open at once`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__withdraw_file_request — retract a still-open request_file card BY requestId (wrong path / no longer needed; re-post request_file if still needed)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__withdraw_secret_request — retract a still-open request_secret card BY requestId (wrong target / no longer needed; re-post request_secret if still needed)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__derive_secret       — store a value YOU computed (not operator-provided; see SECRETS)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__write_workspace_config — AMEND workspace config (mounts; NOT secrets) —`,
      '    a DB write, live instantly for every job on this repo (no PR). Merges with what is already recorded',
      '    (upserts a mount by path) — pass only the ONE new entry you are adding; existing entries survive',
      '    automatically, you never need to reconstruct the whole set yourself.',
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__write_setup_script  — save the repo's cold-boot SETUP SCRIPT ({ script }) —`,
      '    a DB write, live for every future job on this repo (no PR). The host runs it on EVERY cold sandbox',
      '    bring-up (and skips it warm), so it MUST be idempotent (guard the one-time work) and must NOT init',
      '    submodules (already automatic). It ARMS the box start-ready (install/build/index) — it does NOT START',
      '    runtime services (docker/DB/app server); those are started on demand by the turn that needs them.',
      '    It REPLACES the whole script — call read_setup_script FIRST to see the current body, then write the full new one.',
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__read_setup_script   — read the repo's CURRENT cold-boot SETUP SCRIPT (raw`,
      '    body) so you can edit an existing script safely instead of clobbering it when you write_setup_script.',
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__write_preview_instructions — save the repo's PREVIEW RECIPE ({ instructions })`,
      "    — how to stand up this repo's demo-ready preview stack (envs, ports, compose/migrate/seed, deep-link);",
      '    a DB write, live for every future job on this repo (no PR). It REPLACES the whole recipe — call',
      '    read_preview_instructions FIRST to see the current body, then write the full new one.',
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__read_preview_instructions  — read the repo's CURRENT preview recipe (raw`,
      '    body) so you can edit an existing recipe safely instead of clobbering it when you write_preview_instructions.',
      `  - mcp__${BRIDGE_SERVER_NAME}__reset_sandbox       — recreate your container from scratch to PROVE the`,
      '    environment cold-boots from durable inputs (see RESET). It does not reset instantly — it recreates on',
      '    your NEXT turn, so call it then STOP; you will be prompted to verify once the fresh box is up. Pass',
      '    { hard:true } for a FULL from-scratch reset (fresh worktree AND container, coding session preserved) —',
      '    a two-call confirm (first call explains what is lost; call again to do it); refuses on a dirty/unpushed tree.',
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__propose_mcp_servers  — recommend stack-matched MCP servers ({ servers }) for`,
      '    the OWNER to approve (see MCP SERVERS). Posts a proposal card; you never register servers yourself.',
      '    Declare a static credential slot by name with `secret: true`; fill it after approval via request_secret',
      '    (mcp). For a server that needs INTERACTIVE login, set authKind:"oauth" instead (http/sse only, NO secret',
      '    slot): the OWNER completes consent with the proposal-card Connect button or in the console (MCP settings → Connect) — you cannot, and must never',
      "    inject an Authorization/Bearer header. NOTE: Claude's own design MCP (/design-login, claude.ai design",
      '    files) is NOT onboardable as an MCP here — to use a .dc.html, ask the operator to UPLOAD it.',
      `  - mcp__${BRIDGE_SERVER_NAME}__finish_onboarding   — finish: only after the stack boots green (see FINISH)`,
    ].join('\n');
  }

  /** The review session's curated host tools (order 1041: unique vs hostTools@1040). */
  @Fragment({ usedBy: [Agent.PLANNING], order: 1041, condition: isReview })
  reviewTools(): string {
    return [
      TOOL_QUALIFICATION_NOTE(BRIDGE_SERVER_NAME),
      'Call every host tool with its fields DIRECTLY at the top level (no `args` wrapper).',
      'You have NO plan/build/ship tools this session (no propose_plan or start_direct_build) — a review does',
      'not build its own PR. You MAY still spin up or relate sibling jobs (list_jobs / create_job /',
      'link_job_dependency). You do the work with your NATIVE tools: `gh` via Bash to fetch the PR,',
      'Read/Glob/Grep to study the code, and the `explore`/`review`/`debug`/`test` subagents (Task). Your',
      'host tools this session:',
      `  - mcp__${BRIDGE_SERVER_NAME}__ask_question        — ask/verify ONE thing with the operator (renders as a card)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__withdraw_question   — retract a still-unanswered question BY questionId`,
      `  - mcp__${BRIDGE_SERVER_NAME}__set_job_kind        — re-classify this job if it turns out NOT to be a PR review`,
      `  - mcp__${BRIDGE_SERVER_NAME}__recall              — retrieve relevant memory facts`,
      `  - mcp__${BRIDGE_SERVER_NAME}__remember            — store a durable memory fact about this repo`,
      `  - mcp__${BRIDGE_SERVER_NAME}__forget              — soft-delete a stored memory by id (from a recall/harness [id])`,
      `  - mcp__${BRIDGE_SERVER_NAME}__update_memory       — rewrite a stored memory fact by id (re-embeds)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__list_jobs           — list this repo's sibling jobs to discover ids for peer dependencies`,
      `  - mcp__${BRIDGE_SERVER_NAME}__create_job          — spin off a NEW job on this same repo; optionally born blocked with dependsOn`,
      `  - mcp__${BRIDGE_SERVER_NAME}__link_job_dependency — mark one existing same-repo job as blocked by another (discover ids via list_jobs first)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__request_secret      — securely ask the operator for a SECRET VALUE (only if you need one to run the branch's tests)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__request_file        — ask the operator to UPLOAD a file`,
      `  - mcp__${BRIDGE_SERVER_NAME}__reset_sandbox       — recreate your container from scratch (rarely needed for a review)`,
    ].join('\n');
  }
}
