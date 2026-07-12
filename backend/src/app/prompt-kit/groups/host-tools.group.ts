/**
 * prompt-kit / groups / host-tools — the host MCP tool surface: the fully-qualified tool list, the flat
 * top-level calling convention, and the create_job / tickets tools; plus the onboarding session's curated tool list.
 *
 * TOPIC bucket: host tools. Interpolates the runtime `BRIDGE_SERVER_NAME` and reuses the shared
 * `TOOL_QUALIFICATION_NOTE` catalog block.
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { isBuildBrain, isOnboarding, isReview, notOnboarding } from '../conditions';
import { BRIDGE_SERVER_NAME } from '../../sandbox/image/bridge-options';
import { WORKSPACE_PROFILE_BRIDGE_NAME } from '../../sandbox/image/workspace-profile-bridge-options';
import { LSP_TOOLS_NOTE, TOOL_QUALIFICATION_NOTE } from '../fragments';

@FragmentGroup()
export class HostToolsGroup {
  /** The host tools — qualification + enumeration + ambient capability tools. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1040, condition: isBuildBrain })
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
      `  - mcp__${BRIDGE_SERVER_NAME}__review_plan          — run (or resume) a SYNCHRONOUS Codex review of your authored specs; returns severity-tagged findings (FULL PATH; see below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__propose_plan         — send the reviewed plan to the operator for approval (FULL PATH; requires review_plan first; see below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__withdraw_plan        — retract a still-pending plan/direct-build approval you proposed (flips back to planning; the operator's Approve button clears). Use it when you keep working after proposing; then re-propose when ready.`,
      `  - mcp__${BRIDGE_SERVER_NAME}__withdraw_ship        — PROPOSE amending the READY-TO-SHIP build: posts an "Amend build?" card for the operator. It does NOT retract the gate — only the operator can, by approving. After proposing, STOP and wait; if approved you'll be re-woken to do the work. Frame your reason as YOUR OWN recommendation (never "Operator wants…"). Keeps completed work; the gate re-arms once follow-up work lands.`,
      `  - mcp__${BRIDGE_SERVER_NAME}__start_direct_build   — propose a small change you will implement yourself (FAST PATH; see below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__finalize_build       — (gated) ship an approved direct build: commit → review → open PR`,
      `  - mcp__${BRIDGE_SERVER_NAME}__dispatch_build       — (gated) dispatch an already-approved full build`,
      `  - mcp__${BRIDGE_SERVER_NAME}__retry_thread         — re-drive a HALTED build thread you were woken about, passing {threadId, guidance} (your fix note); bounded attempts, then escalate (see HALTED THREADS)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__note_cleared_block   — record that you CLEARED a halt by RETRIEVING an existing answer, passing {threadId, reason, evidence} (the source you cited); call BEFORE retry_thread (see HALTED THREADS)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__create_job           — spin off a NEW job on this same repo; optionally born blocked with dependsOn (see CREATE_JOB below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__link_job_dependency  — explicitly mark one existing same-repo job as blocked by another`,
      `  - mcp__${BRIDGE_SERVER_NAME}__create_ticket        — capture work on this repo's board/backlog for later (see TICKETS below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__list_tickets         — list this repo's tickets (optionally by status)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__update_ticket        — edit a ticket / move it between board columns`,
      `  - mcp__${BRIDGE_SERVER_NAME}__link_ticket_dependency — record an advisory "blocked by" edge between tickets`,
      `  - mcp__${BRIDGE_SERVER_NAME}__promote_ticket       — turn a backlog ticket into a working follow-up thread`,
      `You ALSO have these AMBIENT capability tools — usable ANY turn, whenever the work hits the friction they solve (see ENVIRONMENT GAPS below):`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__request_secret       — securely request a missing SECRET VALUE from the operator (stored encrypted, rendered to a path; persists for future jobs)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__request_file         — have the operator UPLOAD a whole file/key (env file, service-account JSON, .pem; encrypted, granted to a gitignored path)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__withdraw_file_request — retract a still-open request_file card BY requestId (wrong path / no longer needed); post a corrected request_file if you still need the file`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__derive_secret        — store a value YOU computed from an already-granted credential (no operator wait; e.g. a printed webhook secret)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__write_workspace_config — amend the repo's DB-backed workspace config (mounts) — a live write for every future job on this repo, no PR`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__write_setup_script   — save the repo's cold-boot setup script ({ script }) — runs on EVERY cold sandbox bring-up for every future job on this repo (no PR); must be idempotent. It REPLACES the whole script — read_setup_script FIRST to see the current body`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__read_setup_script    — read the repo's CURRENT cold-boot setup script (raw body) so you can edit it safely before write_setup_script (which overwrites the whole thing)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__reset_sandbox        — recreate your container from scratch to prove the setup cold-boots (recreates on your NEXT turn — call it, then STOP). Add { hard:true } for a full from-scratch reset (fresh worktree + container, session kept) — two-call confirm; refuses on a dirty/unpushed tree`,
    ].join('\n');
  }

  /**
   * The LSP tools (`atlas-lsp-ts`, a SEPARATE MCP server from the host bridge above;
   * the SDK spawns it directly, no host round-trip). Unlike the host-bridge tools, these carry real,
   * specific descriptions from mcp-language-server's own tool registration, so — unlike `hostTools()`
   * above — there is no need to hand-enumerate what each one does here; just the behavioral nudge.
   */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1045, condition: notOnboarding })
  lspTools(): string {
    return LSP_TOOLS_NOTE;
  }

  /** The flat top-level calling convention. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1050, condition: notOnboarding })
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
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1060, condition: isBuildBrain })
  createJob(): string {
    return [
      'CREATE_JOB — when the work splits into a separate unit of its own, create a follow-up thread rather',
      'than overloading this one. Args: { title, firstMessage, dependsOn? }. `firstMessage` is the opening',
      'intent the new thread starts on (write it as you would brief a fresh session). By default the new job',
      'starts scoping immediately and independently. If it explicitly needs another SAME-REPO job to land',
      'first, pass dependsOn: jobId or jobId[] and it is born BLOCKED; its brain will not run until every',
      'blocker resolves. Dependencies are explicit only — never assume an out-of-scope follow-up depends on',
      'the current job unless that is actually required. Use link_job_dependency to add a blocked-by edge',
      'between two existing jobs later. Only do this when the operator asked for a follow-up or the split is',
      'clearly warranted — one tightly-scoped follow-up per call, not a backlog.',
    ].join('\n');
  }

  /** Tickets — the repo board/backlog. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1070, condition: isBuildBrain })
  tickets(): string {
    return [
      "TICKETS — the repo's internal board/backlog. This is the durable place for work that is OUT OF SCOPE",
      'for the current thread but worth remembering — the operator should never have to hold it in their head.',
      'When they say things like "do A now, push B for later" / "add that to the backlog" / "remember to do X',
      'after this", call create_ticket. Args: { title, body?, priority?, kind?, status?, dependsOn?, confirm? } —',
      '  • status defaults to "backlog" (the triage holding pen); the board columns are',
      '    backlog → todo → in_progress → in_review → done (+ cancelled). priority: low|medium|high|urgent.',
      '    kind: feature|bug|chore. dependsOn: ids of tickets this one is blocked by (ADVISORY only — it never',
      '    auto-starts anything; it just records the relationship).',
      '  • The ticket is auto-stamped with where it came from (this thread, and the locked decision if any), so',
      '    capture the CONTEXT in body — enough that it is actionable cold, weeks later.',
      '  • DEDUP: create_ticket first semantic-searches the board. If it returns { needsConfirmation:true,',
      '    similar:[…] }, NOTHING was created — the board already has close matches. Read them: if one already',
      '    covers this, update_ticket that existing one (or skip); only if it is genuinely new, call',
      '    create_ticket again with the SAME args plus confirm:true to file it.',
      'create_ticket vs create_job: a TICKET is a note for LATER (no work starts); a JOB starts work NOW',
      'unless you explicitly pass create_job.dependsOn, in which case it is parked until its blocker resolves.',
      'Default to a ticket when deferring. Use promote_ticket later to turn a ticket into a working thread.',
      'Use list_tickets to check the backlog before proposing new work; update_ticket to re-prioritize or move.',
    ].join('\n');
  }

  /** The onboarding session's curated host tools. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2050, condition: isOnboarding })
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
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__request_secret      — securely ask the operator for a SECRET VALUE (see SECRETS)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__request_file        — ask the operator to UPLOAD a file (JSON/key file; see SECRETS)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__withdraw_file_request — retract a still-open request_file card BY requestId (wrong path / no longer needed; re-post request_file if still needed)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__derive_secret       — store a value YOU computed (not operator-provided; see SECRETS)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__write_workspace_config — AMEND workspace config (mounts; NOT secrets) —`,
      '    a DB write, live instantly for every job on this repo (no PR). Merges with what is already recorded',
      '    (upserts a mount by path) — pass only the ONE new entry you are adding; existing entries survive',
      '    automatically, you never need to reconstruct the whole set yourself.',
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__write_setup_script  — save the repo's cold-boot SETUP SCRIPT ({ script }) —`,
      '    a DB write, live for every future job on this repo (no PR). The host runs it on EVERY cold sandbox',
      '    bring-up (and skips it warm), so it MUST be idempotent (guard the one-time work) and must NOT init',
      '    submodules (already automatic). This is how you record the bring-up steps so a cold box comes up ready.',
      '    It REPLACES the whole script — call read_setup_script FIRST to see the current body, then write the full new one.',
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__read_setup_script   — read the repo's CURRENT cold-boot SETUP SCRIPT (raw`,
      '    body) so you can edit an existing script safely instead of clobbering it when you write_setup_script.',
      `  - mcp__${BRIDGE_SERVER_NAME}__reset_sandbox       — recreate your container from scratch to PROVE the`,
      '    environment cold-boots from durable inputs (see RESET). It does not reset instantly — it recreates on',
      '    your NEXT turn, so call it then STOP; you will be prompted to verify once the fresh box is up. Pass',
      '    { hard:true } for a FULL from-scratch reset (fresh worktree AND container, coding session preserved) —',
      '    a two-call confirm (first call explains what is lost; call again to do it); refuses on a dirty/unpushed tree.',
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__propose_mcp_servers  — recommend stack-matched MCP servers ({ servers }) for`,
      '    the OWNER to approve (see MCP SERVERS). Posts a proposal card; you never register servers yourself.',
      '    Declare a static credential slot by name with `secret: true`; fill it after approval via request_secret',
      '    (mcp). For a server that needs INTERACTIVE login, set authKind:"oauth" instead (http/sse only, NO secret',
      '    slot): the OWNER completes consent in the console (MCP settings → Connect) — you cannot, and must never',
      "    inject an Authorization/Bearer header. NOTE: Claude's own design MCP (/design-login, claude.ai design",
      '    files) is NOT onboardable as an MCP here — to use a .dc.html, ask the operator to UPLOAD it.',
      `  - mcp__${BRIDGE_SERVER_NAME}__finish_onboarding   — finish: only after the stack boots green (see FINISH)`,
    ].join('\n');
  }

  /** The review session's curated host tools (order 1041: unique vs hostTools@1040). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1041, condition: isReview })
  reviewTools(): string {
    return [
      TOOL_QUALIFICATION_NOTE(BRIDGE_SERVER_NAME),
      'Call every host tool with its fields DIRECTLY at the top level (no `args` wrapper).',
      'You have NO build/plan/ship tools this session (no propose_plan, start_direct_build, create_job, or',
      'tickets) — a review does not build. You do the work with your NATIVE tools: `gh` via Bash to fetch the',
      'PR, Read/Glob/Grep to study the code, and the `explore`/`review`/`debug`/`test` subagents (Task). Your',
      'host tools this session:',
      `  - mcp__${BRIDGE_SERVER_NAME}__ask_question        — ask/verify ONE thing with the operator (renders as a card)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__withdraw_question   — retract a still-unanswered question BY questionId`,
      `  - mcp__${BRIDGE_SERVER_NAME}__set_job_kind        — re-classify this job if it turns out NOT to be a PR review`,
      `  - mcp__${BRIDGE_SERVER_NAME}__recall              — retrieve relevant memory facts`,
      `  - mcp__${BRIDGE_SERVER_NAME}__remember            — store a durable memory fact about this repo`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__request_secret      — securely ask the operator for a SECRET VALUE (only if you need one to run the branch's tests)`,
      `  - mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__request_file        — ask the operator to UPLOAD a file`,
      `  - mcp__${BRIDGE_SERVER_NAME}__reset_sandbox       — recreate your container from scratch (rarely needed for a review)`,
    ].join('\n');
  }
}
