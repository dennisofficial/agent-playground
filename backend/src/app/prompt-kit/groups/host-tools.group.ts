/**
 * prompt-kit / groups / host-tools — the host MCP tool surface: the fully-qualified tool list, the `args`
 * wrapper contract, and the create_job / tickets tools; plus the onboarding session's curated tool list.
 *
 * TOPIC bucket: host tools. Interpolates the runtime `BRIDGE_SERVER_NAME` and reuses the shared
 * `TOOL_QUALIFICATION_NOTE` catalog block, exactly as the source bodies did.
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { isOnboarding, notOnboarding } from '../conditions';
import { BRIDGE_SERVER_NAME } from '../../sandbox/image/bridge-options';
import { LSP_TOOLS_NOTE, TOOL_QUALIFICATION_NOTE } from '../fragments';

@FragmentGroup()
export class HostToolsGroup {
  /** normal block 04 — the host tools (qualification + enumeration + ambient capability tools). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1040, condition: notOnboarding })
  hostTools(): string {
    return [
      `You have the host tools listed below. ${TOOL_QUALIFICATION_NOTE(BRIDGE_SERVER_NAME)}`,
      `The prose below abbreviates these to short names for readability, but you must call the`,
      `mcp__${BRIDGE_SERVER_NAME}__ form. Your host tools:`,
      `  - mcp__${BRIDGE_SERVER_NAME}__ask_question         — ask the operator one focused question (renders as a card; you may have several open at once; see GRILLING)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__withdraw_question    — retract a still-unanswered question BY questionId (to reword it or if it's now moot; never re-ask an open one — see the <open-questions> turn header)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__create_decision      — lock an always-ask decision (attaches the answered question — pass questionId to name which one, else the one just answered; set confirmedByOperator when the operator chose it, see GRILLING); returns its stable id`,
      `  - mcp__${BRIDGE_SERVER_NAME}__update_decision      — revise a locked decision BY ID (ruling/title/class)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__delete_decision      — drop a locked decision BY ID`,
      `  - mcp__${BRIDGE_SERVER_NAME}__get_pipeline_state   — read the current job/pipeline state for this thread`,
      `  - mcp__${BRIDGE_SERVER_NAME}__get_decision_record  — read back the locked decisions (RECOVERY ONLY — see below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__recall               — retrieve relevant memory facts (semantic search)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__remember             — store a new memory fact`,
      `  - mcp__${BRIDGE_SERVER_NAME}__review_plan          — run (or resume) a SYNCHRONOUS Codex review of your authored specs; returns severity-tagged findings (FULL PATH; see below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__propose_plan         — send the reviewed plan to the operator for approval (FULL PATH; requires review_plan first; see below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__start_direct_build   — propose a small change you will implement yourself (FAST PATH; see below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__finalize_build       — (gated) ship an approved direct build: commit → review → open PR`,
      `  - mcp__${BRIDGE_SERVER_NAME}__promote_decisions    — write durable cross-cutting decisions to the .atlas/decisions ledger (AT SHIP; see DECISION LEDGER)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__dispatch_build       — (gated) dispatch an already-approved full build`,
      `  - mcp__${BRIDGE_SERVER_NAME}__retry_thread         — re-drive a HALTED build thread you were woken about, passing {threadId, guidance} (your fix note); bounded attempts, then escalate (see HALTED THREADS)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__create_job           — spin off a NEW job on this same repo (see CREATE_JOB below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__create_ticket        — capture work on this repo's board/backlog for later (see TICKETS below)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__list_tickets         — list this repo's tickets (optionally by status)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__update_ticket        — edit a ticket / move it between board columns`,
      `  - mcp__${BRIDGE_SERVER_NAME}__link_ticket_dependency — record an advisory "blocked by" edge between tickets`,
      `  - mcp__${BRIDGE_SERVER_NAME}__promote_ticket       — turn a backlog ticket into a working follow-up thread`,
      `You ALSO have these AMBIENT capability tools — usable ANY turn, whenever the work hits the friction they solve (see ENVIRONMENT GAPS below):`,
      `  - mcp__${BRIDGE_SERVER_NAME}__request_secret       — securely request a missing SECRET VALUE from the operator (stored encrypted, rendered to a path; persists for future jobs)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__request_file         — have the operator UPLOAD a whole file/key (env file, service-account JSON, .pem; encrypted, granted to a gitignored path)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__withdraw_file_request — retract a still-open request_file card BY requestId (wrong path / no longer needed); post a corrected request_file if you still need the file`,
      `  - mcp__${BRIDGE_SERVER_NAME}__derive_secret        — store a value YOU computed from an already-granted credential (no operator wait; e.g. a printed webhook secret)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__write_worktree_config — amend the repo's DB-backed worktree config (mounts) — a live write for every future job on this repo, no PR`,
      `  - mcp__${BRIDGE_SERVER_NAME}__reset_sandbox        — recreate your container from scratch to prove the setup cold-boots (recreates on your NEXT turn — call it, then STOP)`,
    ].join('\n');
  }

  /**
   * normal block 045 — the LSP tools (`atlas-lsp-ts`, a SEPARATE MCP server from the host bridge above;
   * the SDK spawns it directly, no host round-trip). Unlike the host-bridge tools, these carry real,
   * specific descriptions from mcp-language-server's own tool registration, so — unlike `hostTools()`
   * above — there is no need to hand-enumerate what each one does here; just the behavioral nudge.
   */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1045, condition: notOnboarding })
  lspTools(): string {
    return LSP_TOOLS_NOTE;
  }

  /** normal block 05 — the args-wrapper calling convention. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1050, condition: notOnboarding })
  argsWrapper(): string {
    return [
      'ARGUMENTS — every host tool takes a SINGLE object parameter named `args`; put ALL fields inside it.',
      'The shorthand below (e.g. `create_decision({ decisionClass, ruling })`) ALWAYS means the wrapped form',
      '`create_decision({ args: { decisionClass, ruling } })`. A call that puts the fields at the TOP LEVEL',
      '(no `args` wrapper) arrives EMPTY at the host and fails — always nest them under `args`.',
    ].join('\n');
  }

  /** normal block 06 — create_job (spin off a follow-up thread NOW). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1060, condition: notOnboarding })
  createJob(): string {
    return [
      'CREATE_JOB — when the work splits into a separate unit of its own AND should start NOW, create a',
      'follow-up thread rather than overloading this one. Args: { title, firstMessage }. `firstMessage` is the',
      'opening intent the new thread starts on (write it as you would brief a fresh session); the new thread',
      'starts scoping immediately and independently. Only do this when the operator asked for a follow-up or',
      'the split is clearly warranted — one tightly-scoped follow-up per call, not a backlog.',
    ].join('\n');
  }

  /** normal block 07 — tickets (the repo board/backlog). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1070, condition: notOnboarding })
  tickets(): string {
    return [
      "TICKETS — the repo's internal board/backlog. This is the durable place for work that is OUT OF SCOPE",
      'for the current thread but worth remembering — the operator should never have to hold it in their head.',
      'When they say things like "do A now, push B for later" / "add that to the backlog" / "remember to do X',
      'after this", call create_ticket. Args: { title, body?, priority?, kind?, status?, dependsOn? } —',
      '  • status defaults to "backlog" (the triage holding pen); the board columns are',
      '    backlog → todo → in_progress → in_review → done (+ cancelled). priority: low|medium|high|urgent.',
      '    kind: feature|bug|chore. dependsOn: ids of tickets this one is blocked by (ADVISORY only — it never',
      '    auto-starts anything; it just records the relationship).',
      '  • The ticket is auto-stamped with where it came from (this thread, and the locked decision if any), so',
      '    capture the CONTEXT in body — enough that it is actionable cold, weeks later.',
      'create_ticket vs create_job: a TICKET is a note for LATER (no work starts); a JOB starts work NOW.',
      'Default to a ticket when deferring. Use promote_ticket later to turn a ticket into a working thread.',
      'Use list_tickets to check the backlog before proposing new work; update_ticket to re-prioritize or move.',
    ].join('\n');
  }

  /** onboarding block 05 — the onboarding session's curated host tools. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2050, condition: isOnboarding })
  onboardingTools(): string {
    return [
      TOOL_QUALIFICATION_NOTE(BRIDGE_SERVER_NAME),
      'Every host tool takes a SINGLE object',
      'parameter named `args` — put ALL fields inside it (e.g. request_secret({ args: { name, path, description } })).',
      'Your host tools this session:',
      `  - mcp__${BRIDGE_SERVER_NAME}__ask_question        — ask/verify ONE thing with the operator (renders as a card)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__withdraw_question   — retract a still-unanswered question BY questionId (reword/moot; never re-ask an open one)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__recall              — retrieve relevant memory facts`,
      `  - mcp__${BRIDGE_SERVER_NAME}__remember            — store a durable memory fact about this repo`,
      `  - mcp__${BRIDGE_SERVER_NAME}__request_secret      — securely ask the operator for a SECRET VALUE (see SECRETS)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__request_file        — ask the operator to UPLOAD a file (JSON/key file; see SECRETS)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__withdraw_file_request — retract a still-open request_file card BY requestId (wrong path / no longer needed; re-post request_file if still needed)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__derive_secret       — store a value YOU computed (not operator-provided; see SECRETS)`,
      `  - mcp__${BRIDGE_SERVER_NAME}__write_worktree_config — AMEND worktree config (mounts; NOT secrets) —`,
      '    a DB write, live instantly for every job on this repo (no PR). Merges with what is already recorded',
      '    (upserts a mount by path) — pass only the ONE new entry you are adding; existing entries survive',
      '    automatically, you never need to reconstruct the whole set yourself.',
      `  - mcp__${BRIDGE_SERVER_NAME}__reset_sandbox       — recreate your container from scratch to PROVE the`,
      '    environment cold-boots from durable inputs (see RESET). It does not reset instantly — it recreates on',
      '    your NEXT turn, so call it then STOP; you will be prompted to verify once the fresh box is up.',
      `  - mcp__${BRIDGE_SERVER_NAME}__finish_onboarding   — finish: only after the stack boots green (see FINISH)`,
    ].join('\n');
  }
}
