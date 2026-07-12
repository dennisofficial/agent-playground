/**
 * The SINGLE canonical source of Zod schemas for every Atlas host-bridge tool, shared by both engines:
 * the Claude in-process bridge (`engine-entrypoint.ts` `makeProxyTool`) registers `TOOL_SHAPES[name]`
 * directly, and the Codex stdio bridge (`mcp-bridge-server.ts`) advertises `toolJsonSchema(name)`.
 *
 * The Claude SDK wraps each shape in a STRICT object that STRIPS unknown keys and REJECTS wrong types, so
 * EVERY field a host handler reads MUST be declared here or it is silently dropped before the handler sees
 * it. Enums are pinned with `z.enum` ONLY for closed, unconditionally-validated sets; every other enum-ish
 * field stays `z.string()` because the handler coerces/validates it tolerantly and a strict enum would
 * reject input the handler would have accepted.
 *
 * Side-effect-free and Nest-free: importable from the bundled sandbox entrypoints without pulling in the app.
 */
import { z } from 'zod/v4';

export type ToolShape = z.ZodRawShape;

// Verification evidence a handler accepts as EITHER an array of structured records OR a free-text string.
const verificationField = z.union([
  z.array(
    z.object({
      kind: z.string().optional(),
      command: z.string().optional(),
      exitCode: z.number().optional(),
      outputTail: z.string().optional(),
    }),
  ),
  z.string(),
]);

// A single decision as review_plan / propose_plan / start_direct_build carry it.
const decisionItem = z.object({
  decisionClass: z.string(),
  title: z.string(),
  ruling: z.string(),
  id: z.string().optional(),
  question: z.string().optional(),
  answer: z.string().optional(),
  confirmedByOperator: z.boolean().optional(),
});

// A single proposed thread (with optional steps) as review_plan / propose_plan carry it.
const threadItem = z.object({
  title: z.string().optional(),
  brief: z.string().optional(),
  type: z.string().optional(),
  steps: z
    .array(z.object({ title: z.string().optional(), brief: z.string().optional() }))
    .optional(),
});

export const TOOL_SHAPES: Record<string, ToolShape> = {
  // ── Driver tools (buildTurnBridge) ────────────────────────────────────────────────────────────
  complete_thread: {
    summary: z.string(),
    changes: z.array(z.string()).optional(),
    verification: verificationField.optional(),
    deviations: z.array(z.string()).optional(),
    gaps: z.array(z.string()).optional(),
  },
  request_operator_input: {
    question: z.string(),
  },
  block_thread: {
    reason: z.enum(['question', 'needs_env', 'decision']),
    detail: z.string(),
    gaps: z.array(z.string()).optional(),
  },
  record_leg_handoff: {
    handoff: z.string(),
  },
  record_deviation: {
    note: z.string(),
  },
  task_create: {
    subject: z.string(),
    description: z.string().optional(),
    activeForm: z.string().optional(),
    blockedBy: z.array(z.string()).optional(),
    addBlockedBy: z.array(z.string()).optional(),
    removeBlockedBy: z.array(z.string()).optional(),
    addBlocks: z.array(z.string()).optional(),
    removeBlocks: z.array(z.string()).optional(),
  },
  task_update: {
    taskId: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional(),
    subject: z.string().optional(),
    description: z.string().optional(),
    activeForm: z.string().optional(),
    blockedBy: z.array(z.string()).optional(),
    addBlockedBy: z.array(z.string()).optional(),
    removeBlockedBy: z.array(z.string()).optional(),
    addBlocks: z.array(z.string()).optional(),
    removeBlocks: z.array(z.string()).optional(),
  },
  // Superset serving BOTH the driver gate and the brain — all fields optional.
  report_verification: {
    passed: z.boolean().optional(),
    verification: verificationField.optional(),
    remaining: z.array(z.string()).optional(),
  },

  // ── Brain tools (buildTools) ──────────────────────────────────────────────────────────────────
  get_pipeline_state: {},
  get_decision_record: {},
  dispatch_build: {},
  hold_build: { reason: z.string() },
  finalize_build: {},
  list_mcp_servers: {},
  list_skills: {},
  list_convention_profiles: {},
  recall: {
    query: z.string().optional(),
  },
  remember: {
    fact: z.string(),
    scope: z.string().optional(),
  },
  ask_question: {
    question: z.string(),
    options: z
      .array(
        z.union([
          z.string(),
          z.object({
            label: z.string(),
            id: z.string().optional(),
            description: z.string().optional(),
          }),
        ]),
      )
      .optional(),
    decisionClass: z.string().optional(),
    header: z.string().optional(),
    allowOther: z.boolean().optional(),
  },
  withdraw_question: {
    questionId: z.string(),
    reason: z.string().optional(),
  },
  withdraw_plan: {
    reason: z.string().optional(),
  },
  withdraw_ship: {
    reason: z.string().optional(),
  },
  set_job_kind: {
    kind: z.enum(['feature', 'bugfix', 'review']),
  },
  create_decision: {
    decisionClass: z.string(),
    ruling: z.string(),
    questionId: z.string().optional(),
    confirmedByOperator: z.boolean().optional(),
    title: z.string().optional(),
  },
  update_decision: {
    id: z.string(),
    confirmedByOperator: z.boolean().optional(),
    questionId: z.string().optional(),
    decisionClass: z.string().optional(),
    ruling: z.string().optional(),
    title: z.string().optional(),
  },
  delete_decision: {
    id: z.string(),
  },
  review_plan: {
    overview: z.string().optional(),
    goal: z.string().optional(),
    note: z.string().optional(),
    decisions: z.array(decisionItem).optional(),
    threads: z.array(threadItem).optional(),
  },
  propose_plan: {
    overview: z.string(),
    goal: z.string(),
    kind: z.string().optional(),
    decisions: z.array(decisionItem).optional(),
    threads: z.array(threadItem),
  },
  retry_thread: {
    threadId: z.string(),
    guidance: z.string().optional(),
  },
  note_cleared_block: {
    threadId: z.string(),
    reason: z.string().optional(),
    evidence: z.string(),
  },
  start_direct_build: {
    summary: z.string(),
    changeOutline: z.array(z.string()).optional(),
    kind: z.string().optional(),
    decisions: z.array(decisionItem).optional(),
  },
  create_job: {
    firstMessage: z.string(),
    title: z.string().optional(),
    dependsOn: z.union([z.string(), z.array(z.string())]).optional(),
  },
  list_jobs: {
    status: z.string().optional(), // a specific status, or 'all' to include terminal jobs
    query: z.string().optional(), // case-insensitive title substring
    limit: z.number().optional(), // default 30, hard cap 100
  },
  link_job_dependency: {
    jobId: z.string(),
    dependsOnJobId: z.string(),
  },
  propose_convention_profile_change: {
    slug: z.string(),
    body: z.string(),
    rationale: z.string(),
    name: z.string().optional(),
    detectHint: z.string().optional(),
  },

  // ── Workspace-profile tools (intake + onboarding) ─────────────────────────────────────────────
  request_secret: {
    name: z.string().optional(),
    path: z.string().optional(),
    description: z.string(),
    url: z.string().optional(),
    ephemeral: z.boolean().optional(),
    deliver_to: z.string().optional(),
    mcp: z
      .object({
        server: z.string().optional(),
        slot: z.enum(['header', 'env']).optional(),
        key: z.string().optional(),
      })
      .optional(),
  },
  request_file: {
    path: z.string(),
    description: z.string(),
  },
  withdraw_file_request: {
    requestId: z.string(),
    reason: z.string().optional(),
  },
  write_workspace_config: {
    mounts: z
      .array(
        z.object({
          path: z.string(),
          mode: z.string().optional(),
        }),
      )
      .optional(),
    secrets: z.unknown().optional(),
  },
  write_setup_script: {
    script: z.string().optional(),
  },
  read_setup_script: {},
  derive_secret: {
    name: z.string(),
    path: z.string(),
    value: z.string(),
    description: z.string(),
    overwrite: z.boolean().optional(),
  },
  reset_sandbox: {
    reason: z.string().optional(),
    hard: z.boolean().optional(),
  },
  propose_skill: {
    name: z.string(),
    description: z.string(),
    rationale: z.string(),
    scope: z.string().optional(),
  },
  propose_skill_install: {
    sourceUrl: z.string(),
    ref: z.string().optional(),
    subpath: z.string().optional(),
    rationale: z.string(),
    scope: z.string().optional(),
  },
  request_skill_edit_access: {
    skill: z.string(),
    rationale: z.string(),
  },
  propose_skill_removal: {
    name: z.string(),
    rationale: z.string(),
    scope: z.string().optional(),
  },
  propose_mcp_servers: {
    servers: z.array(
      z.object({
        name: z.string(),
        transport: z.enum(['http', 'sse', 'stdio']),
        url: z.string().optional(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        // `'static'` (default) = header/env credential slots filled via request_secret. `'oauth'` = interactive
        // OAuth 2.1 the OWNER completes in the console ("Connect"); http/sse only, no secret slots.
        authKind: z.enum(['static', 'oauth']).optional(),
        oauth: z
          .object({
            scope: z.string().optional(),
            tokenAuthMethod: z
              .enum(['none', 'client_secret_post', 'client_secret_basic'])
              .optional(),
          })
          .optional(),
        headers: z
          .array(
            z.object({
              name: z.string(),
              secret: z.boolean().optional(),
              value: z.string().optional(),
            }),
          )
          .optional(),
        env: z
          .array(
            z.object({
              name: z.string(),
              secret: z.boolean().optional(),
              value: z.string().optional(),
            }),
          )
          .optional(),
        surfaces: z.array(z.string()).optional(),
        reason: z.string().optional(),
      }),
    ),
    scope: z.string().optional(),
  },
  propose_mcp_removal: {
    name: z.string(),
    rationale: z.string(),
    scope: z.string().optional(),
  },
  propose_convention_profile: {
    slug: z.string().optional(),
    rationale: z.string().optional(),
  },
  finish_onboarding: {
    summary: z.string().optional(),
    verified: z.string(),
  },
};

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  // ── Driver tools ──────────────────────────────────────────────────────────────────────────────
  complete_thread:
    'Assert this thread is DONE. Call exactly once when the work is complete and verified. Provide a ' +
    'one-line summary plus, ideally, the changes you made and the verification you ran.',
  request_operator_input:
    'Ask the operator a blocking question when you need a human decision before you can continue.',
  block_thread:
    'Voluntarily HALT this thread — you cannot make progress this turn and there is nothing to poll for. ' +
    'Use complete_thread when done instead.',
  record_leg_handoff: 'Record a handoff note for the next leg of this thread before you stop.',
  record_deviation: 'Log a one-line off-spec change you made so it surfaces to the operator.',
  task_create:
    'Add ONE item to your live task list (shown to the operator as a checklist for this thread). Call it ' +
    'up front for each concrete step you plan to do, and as new work emerges. Returns the created task id.',
  task_update:
    'Update one task in your live task list — mark it in_progress when you start it and completed when it ' +
    'is done (exactly one task should be in_progress at a time). Use status "deleted" to remove a task.',
  report_verification:
    'Report the verification you ran for a DIRECT BUILD before shipping. Pass passed:true only once ' +
    'diagnostics + the repo typecheck are clean AND — if you touched a runtime surface (HTTP endpoint, UI ' +
    'page/component, CLI entry point, or background job) — you have ACTUALLY EXERCISED IT LIVE (booted the ' +
    'process and curled the endpoint / drove the UI / ran the CLI for real). Include that live evidence in ' +
    '`verification` (the real command, its exit code, a tail of its output). Before passing passed:true, ' +
    'actually LOOK at the evidence you captured — a screenshot showing an error / "connection lost" / blank ' +
    'page (or a log full of failures) means the check FAILED, not passed; do not report it as green. ' +
    'finalize_build runs a ' +
    'live-verification judge over this evidence and refuses to ship a runtime change you only typechecked. ' +
    'If you cannot get things clean, pass passed:false with `remaining` listing the specific errors.',

  // ── Brain tools ───────────────────────────────────────────────────────────────────────────────
  get_pipeline_state: 'Read the current pipeline state (threads, decisions, plan) for this job.',
  get_decision_record: 'Read the full decision record for this job.',
  dispatch_build:
    'Start the approved build after the base-check (branches internally: full plan → build pipeline, direct → in-session implement).',
  hold_build:
    'Hold the approved build and return to planning when the rebased base makes the plan redundant or requires revision (reason surfaced to the operator).',
  finalize_build: 'Finalize the build once every thread is complete and verified.',
  list_mcp_servers: 'List the MCP servers configured for this org/repo.',
  list_skills: 'List the skills available to this workspace.',
  list_convention_profiles: 'List the convention (house-style) profiles for this repo.',
  recall: 'Recall stored facts relevant to an optional query.',
  remember: 'Store a durable fact at the given scope for later recall.',
  ask_question: 'Ask the operator a question, optionally with pickable options and a decision class.',
  withdraw_question: 'Withdraw a pending question you no longer need answered.',
  withdraw_plan: 'Withdraw the current proposed plan.',
  withdraw_ship:
    'PROPOSE amending the current ship-review build — posts an "Amend build?" card for the operator. Does NOT ' +
    'retract the gate; only the operator can, by approving. Do not keep building while it is pending.',
  set_job_kind: 'Set this job kind (feature, bugfix, or review).',
  create_decision: 'Record a new decision for this job.',
  update_decision: 'Update an existing decision by id.',
  delete_decision: 'Delete a decision by id.',
  review_plan: 'Review and revise the current plan overview, goal, decisions, and threads.',
  propose_plan: 'Propose a plan: an overview, goal, decisions, and the threads to build.',
  retry_thread: 'Retry a failed or blocked thread, optionally with fresh guidance.',
  note_cleared_block: 'Record that a thread block is cleared, with the evidence that cleared it.',
  start_direct_build: 'Start a direct build with a summary, change outline, and decisions.',
  create_job:
    'Create a new job seeded with a first message; optionally dependsOn one or more existing job ids on this repo to be born blocked until they merge.',
  list_jobs:
    "List this repo's jobs (newest first) so you can discover sibling job ids to wire peer dependencies. " +
    'Defaults to in-flight jobs; pass status to filter (or "all" to include finished ones), query for a title substring, limit to cap results.',
  link_job_dependency:
    'Link one job as blocked-by (depending on) another existing job on this repo; parks the now-blocked job until the blocker resolves.',
  propose_convention_profile_change:
    'Propose a change to a convention (house-style) profile, with body and rationale.',

  // ── Workspace-profile tools ───────────────────────────────────────────────────────────────────
  request_secret:
    'Request a secret from the operator (file, env, or MCP header/env slot). NOT for OAuth MCP servers — ' +
    'those are connected by the owner with the MCP proposal-card Connect button or in the console (MCP settings → Connect), never via a pasted secret.',
  request_file: 'Request a file from the operator at a given path, with a description.',
  withdraw_file_request: 'Withdraw a pending file request you no longer need.',
  write_workspace_config: 'Write the workspace config (mounts) for this repo.',
  write_setup_script: 'Write the per-sandbox setup script for this workspace.',
  read_setup_script:
    'Read the repo\'s current cold-boot setup script (the raw body, not just its length) so you can edit it ' +
    'safely before calling write_setup_script — which REPLACES the whole script. Returns { ok, present, script }.',
  derive_secret: 'Derive and store a secret file at a path from a computed value.',
  reset_sandbox:
    'Recreate this job’s sandbox so you can PROVE it cold-boots from durable config. Default: recreates the ' +
    'CONTAINER only (worktree + session survive). `hard:true`: recreates the WHOLE sandbox from scratch — ' +
    'fresh worktree AND container, as if the job just started — while keeping your coding session (history ' +
    'resumes) and the /context + /playground mounts. A hard reset is a TWO-CALL CONFIRM: the first call ' +
    'describes what happens / what is lost and does nothing; call it again to actually reset. It REFUSES on ' +
    'a dirty tree or unpushed commits (the host never commits for you — commit + push first). The reset ' +
    'happens on your NEXT turn — call it, then STOP.',
  propose_skill: 'Propose a new skill for this org or repo, with rationale.',
  propose_skill_install: 'Propose installing a skill from a source URL for this org or repo.',
  request_skill_edit_access: 'Request edit access to an existing skill, with rationale.',
  propose_skill_removal: 'Propose removing a skill from this org or repo.',
  propose_mcp_servers:
    'Propose one or more MCP servers for this org or repo. Use authKind:"oauth" (http/sse, no secret slot) ' +
    'for a server that needs interactive login — the owner completes it via the console Connect.',
  propose_mcp_removal: 'Propose removing an MCP server from this org or repo.',
  propose_convention_profile: 'Propose a new convention (house-style) profile for this repo.',
  finish_onboarding:
    'Finish workspace onboarding with a summary and the verification you performed. For a repo with ' +
    'user-facing surfaces, `verified` must include live preview-accessibility evidence — each public preview ' +
    'URL loaded + hydrated as a browser via atlas-probe, plus the authed-handshake proof where a surface has ' +
    'auth — not just a local health check.',
};

/**
 * The JSON Schema the Codex stdio bridge advertises for a tool. Native in zod 4 via `z.toJSONSchema`.
 * Unknown tools fall back to a permissive object so a call is never rejected before the host sees it.
 */
export function toolJsonSchema(name: string): Record<string, unknown> {
  const shape = TOOL_SHAPES[name];
  return shape
    ? (z.toJSONSchema(z.object(shape)) as Record<string, unknown>)
    : { type: 'object', additionalProperties: true };
}
