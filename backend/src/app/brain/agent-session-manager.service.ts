import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Subscription } from 'rxjs';
import { LeaderElectionService } from '../cluster';
import type { ChatStimulus, Thread, ThreadKind } from '../domain';
import { MemoryStore } from '../memory';
import {
  CHAT_SURFACE,
  type ChatSurface,
  type DecisionApprovalCard,
  LiveTurnStore,
  SYSTEM_SEED_AUTHOR,
  type WebQuestionCard,
  webQuestionCard,
  wrapSystemNotification,
} from '../surface';
import { DB_CONNECTION } from '../persistence/database.module';
import { ThreadSandboxEntity } from '../persistence/entities';
import { ProvisioningNotReadyError, ThreadLifecycleService } from '../driver/thread-lifecycle.service';
import { DriverStoreService } from '../driver/driver-store.service';
import { BuildShipService } from '../driver/build-ship.service';
import { PipelineAwarenessStore } from '../driver/pipeline-awareness.store';
import {
  pipelineStateSignature,
  renderAwarenessPrefix,
  renderPipelineStateSummary,
} from '../driver/pipeline-awareness';
import { DRIVER_REPO, type DriverRepoResolver } from '../driver/repo-resolver';
import type { PlannedStep } from '../driver/planner-llm';
import { DecisionClassifier } from '../decision-gate';
import { CredentialResolver } from '../onboarding';
import { TicketService } from '../tickets';
import type { TicketKind, TicketPriority, TicketStatus } from '../domain/ticket';
import { isTicketKind, isTicketPriority, isTicketStatus } from '../domain/ticket';
import type { Decision } from '../domain';
import { nextDecisionId, DECISION_CLASS_IDS } from '../domain';
import type { DecisionClass } from '../domain/decision-record';
import { renderDecisionRecordMd } from './decision-record-md';
import { DockerEngineRunner } from '../sandbox/docker-engine-runner';
import { BRIDGE_SERVER_NAME } from '../sandbox/image/bridge-options';
import { isUnresumableSessionMessage, SANDBOX_RESET_NOTICE } from '../engine/engine.types';
import type { EngineRunnerPort, ToolImpl, RunEngineArgs, EngineEvent } from '../engine/engine.types';
import { BrainStoreService } from './brain-store.service';
import { DecisionApprovalService } from './decision-approval.service';
import { JOB_DISPATCHER, type JobDispatcher } from './job-dispatcher';
import { PlanReviewService, renderFindingsDelivery } from './plan-review.service';

/**
 * R3 — the AGENT SESSION MANAGER (the chat brain).
 *
 * Replaces `ConversationalBrainService` + `ScopingInvestigatorService`. Each thread gets a per-thread
 * Claude Agent SDK session that runs INSIDE the thread's sandbox via the R1 tool bridge.
 *
 * Architecture:
 *   - On a chat stimulus: run an in-sandbox engine turn via `DockerEngineRunner` (always Docker),
 *     resuming the persisted session_id for the thread.
 *   - The session runs with a custom system prompt (NOT the SDK's native ExitPlanMode) + 6 host-side
 *     tool impls dispatched through the tool bridge.
 *   - `submit_plan` → `persistPlan` (status `plan_review`) → async Codex review → findings delivered to
 *     the session; `finalize_plan` → approval card via `DecisionApprovalService`.
 *   - On approve → `JOB_DISPATCHER.dispatch`; on deny/request_changes → keep talking.
 *   - session_id is persisted on the `thread_sandboxes` row so it survives host restarts.
 */
@Injectable()
export class AgentSessionManager implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AgentSessionManager.name);

  /** Leader-only boot-sweep subscription (turn_active reset + answered-Q / plan-review re-delivery). */
  private leaderBootSub?: Subscription;
  /** The boot sweeps run ONCE per process — never on a mid-life re-promote (would clear active turns). */
  private bootSweepsDone = false;

  /**
   * The thread brain's model — the conversational/planning session that grills, locks decisions, and
   * proposes plans. Pinned to Opus (the SDK accepts the `'opus'` alias → latest Opus). A code constant,
   * NOT an env var — model choice doesn't vary by environment. (Step workers default to Opus too, in
   * `engine-core`'s `DEFAULT_WORKER_MODEL`.)
   */
  private static readonly BRAIN_MODEL = 'opus';

  /**
   * Per-thread turn queue — serializes chat turns for ONE thread so a follow-up sent WHILE a turn is
   * still running waits for it instead of starting a second engine turn that resumes the SAME session id
   * concurrently (which corrupts the session). One thread = one in-flight turn at a time; the next turn
   * resumes the session with the queued message once the current one finishes. Keyed `orgId:threadId`.
   */
  private readonly turnQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly store: BrainStoreService,
    private readonly driverStore: DriverStoreService,
    private readonly memory: MemoryStore,
    private readonly approvals: DecisionApprovalService,
    private readonly lifecycle: ThreadLifecycleService,
    private readonly dockerRunner: DockerEngineRunner,
    private readonly planReview: PlanReviewService,
    @Inject(JOB_DISPATCHER) private readonly dispatcher: JobDispatcher,
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
    @InjectRepository(ThreadSandboxEntity, DB_CONNECTION)
    private readonly sandboxRows: Repository<ThreadSandboxEntity>,
    private readonly liveTurns: LiveTurnStore,
    // Fast (direct-build) path: classify always-ask decisions, resolve the repo, and ship the result.
    private readonly classifier: DecisionClassifier,
    private readonly ship: BuildShipService,
    @Inject(DRIVER_REPO) private readonly repos: DriverRepoResolver,
    // Passive pipeline-milestone awareness: the durable per-thread buffer drained into each operator turn.
    private readonly awareness: PipelineAwarenessStore,
    // The internal board/backlog — captured out-of-scope work + promotion to follow-up threads.
    private readonly tickets: TicketService,
    // Per-org engine subscription secret for the in-sandbox brain turn (the SDK harness).
    private readonly creds: CredentialResolver,
    // Singleton-leadership gate: boot crash-recovery sweeps + new-turn intake run only on the leader.
    private readonly election: LeaderElectionService,
  ) {}

  // ── System prompt for the custom plan mode ──────────────────────────────────────────────────────

  private static readonly SYSTEM_PROMPT = [
    'You are Atlas, an autonomous software-engineering orchestrator. You are talking with the operator',
    'to shape ONE feature or bug fix, lock the decisions, get ONE approval — then build it autonomously.',
    '',
    `You have 19 host tools, all served by the "${BRIDGE_SERVER_NAME}" MCP server. The SDK exposes each one`,
    `under its fully-qualified name "mcp__${BRIDGE_SERVER_NAME}__<tool>" — that is the ONLY name that works.`,
    `ALWAYS call the qualified name (e.g. mcp__${BRIDGE_SERVER_NAME}__submit_plan); the bare name`,
    '(e.g. submit_plan) is NOT a registered tool and will fail with "No such tool available". The prose',
    `below abbreviates these to short names for readability, but you must call the mcp__${BRIDGE_SERVER_NAME}__`,
    'form. The 19 tools:',
    `  - mcp__${BRIDGE_SERVER_NAME}__ask_question         — ask the operator ONE formal question (renders as a card; see GRILLING)`,
    `  - mcp__${BRIDGE_SERVER_NAME}__create_decision      — lock an always-ask decision (auto-attaches the last answered question; set confirmedByOperator when the operator chose it, see GRILLING); returns its stable id`,
    `  - mcp__${BRIDGE_SERVER_NAME}__update_decision      — revise a locked decision BY ID (ruling/title/class)`,
    `  - mcp__${BRIDGE_SERVER_NAME}__delete_decision      — drop a locked decision BY ID`,
    `  - mcp__${BRIDGE_SERVER_NAME}__get_pipeline_state   — read the current job/pipeline state for this thread`,
    `  - mcp__${BRIDGE_SERVER_NAME}__get_decision_record  — read back the locked decisions (RECOVERY ONLY — see below)`,
    `  - mcp__${BRIDGE_SERVER_NAME}__recall               — retrieve relevant memory facts (semantic search)`,
    `  - mcp__${BRIDGE_SERVER_NAME}__remember             — store a new memory fact`,
    `  - mcp__${BRIDGE_SERVER_NAME}__submit_plan          — submit the full multi-track plan for an async Codex review (FULL PATH; see below)`,
    `  - mcp__${BRIDGE_SERVER_NAME}__finalize_plan        — send the Codex-reviewed plan to the operator for approval (FULL PATH; see below)`,
    `  - mcp__${BRIDGE_SERVER_NAME}__start_direct_build   — propose a small change you will implement yourself (FAST PATH; see below)`,
    `  - mcp__${BRIDGE_SERVER_NAME}__finalize_build       — (gated) ship an approved direct build: commit → review → open PR`,
    `  - mcp__${BRIDGE_SERVER_NAME}__dispatch_build       — (gated) dispatch an already-approved full build`,
    `  - mcp__${BRIDGE_SERVER_NAME}__create_thread        — spin off a NEW thread on this same repo (see CREATE_THREAD below)`,
    `  - mcp__${BRIDGE_SERVER_NAME}__create_ticket        — capture work on this repo's board/backlog for later (see TICKETS below)`,
    `  - mcp__${BRIDGE_SERVER_NAME}__list_tickets         — list this repo's tickets (optionally by status)`,
    `  - mcp__${BRIDGE_SERVER_NAME}__update_ticket        — edit a ticket / move it between board columns`,
    `  - mcp__${BRIDGE_SERVER_NAME}__link_ticket_dependency — record an advisory "blocked by" edge between tickets`,
    `  - mcp__${BRIDGE_SERVER_NAME}__promote_ticket       — turn a backlog ticket into a working follow-up thread`,
    '',
    'ARGUMENTS — every host tool takes a SINGLE object parameter named `args`; put ALL fields inside it.',
    'The shorthand below (e.g. `create_decision({ decisionClass, ruling })`) ALWAYS means the wrapped form',
    '`create_decision({ args: { decisionClass, ruling } })`. A call that puts the fields at the TOP LEVEL',
    '(no `args` wrapper) arrives EMPTY at the host and fails — always nest them under `args`.',
    '',
    'CREATE_THREAD — when the work splits into a separate unit of its own AND should start NOW, create a',
    'follow-up thread rather than overloading this one. Args: { title, firstMessage }. `firstMessage` is the',
    'opening intent the new thread starts on (write it as you would brief a fresh session); the new thread',
    'starts scoping immediately and independently. Only do this when the operator asked for a follow-up or',
    'the split is clearly warranted — one tightly-scoped follow-up per call, not a backlog.',
    '',
    'TICKETS — the repo\'s internal board/backlog. This is the durable place for work that is OUT OF SCOPE',
    'for the current thread but worth remembering — the operator should never have to hold it in their head.',
    'When they say things like "do A now, push B for later" / "add that to the backlog" / "remember to do X',
    'after this", call create_ticket. Args: { title, body?, priority?, kind?, status?, dependsOn? } —',
    '  • status defaults to "backlog" (the triage holding pen); the board columns are',
    '    backlog → todo → in_progress → in_review → done (+ cancelled). priority: low|medium|high|urgent.',
    '    kind: feature|bug|chore. dependsOn: ids of tickets this one is blocked by (ADVISORY only — it never',
    '    auto-starts anything; it just records the relationship).',
    '  • The ticket is auto-stamped with where it came from (this thread, and the locked decision if any), so',
    '    capture the CONTEXT in body — enough that it is actionable cold, weeks later.',
    'create_ticket vs create_thread: a TICKET is a note for LATER (no work starts); a THREAD starts work NOW.',
    'Default to a ticket when deferring. Use promote_ticket later to turn a ticket into a working thread.',
    'Use list_tickets to check the backlog before proposing new work; update_ticket to re-prioritize or move.',
    '',
    'INVESTIGATE FIRST: before proposing anything, ground yourself in the repo with Read/Glob/Grep (stack,',
    'structure, conventions, the exact files you will touch). Never ask the operator anything the repo',
    'already answers (tech stack, file existence, tooling, how the codebase does something).',
    'DOCS BEFORE GREP: if the repo has orienting docs — CLAUDE.md, AGENTS.md, README.md, ARCHITECTURE.md,',
    'CONTRIBUTING.md, docs/ — READ those FIRST; they are the human-curated map and let you skip a grep-storm',
    'to rediscover where things live and how this codebase does things. Then Read/Glob/Grep to confirm the',
    'specific files you will touch. Treat docs as orientation that may be stale — the CODE is authoritative;',
    'where a doc and the code disagree, trust the code.',
    'DELEGATE BIG INVESTIGATIONS: for anything beyond a couple of reads — tracing how a feature works across',
    'many files, mapping conventions in an unfamiliar area, or researching a library — spawn the read-only',
    '`explore` subagent via the Task tool (Task({ subagent_type: "explore", description, prompt })). It runs',
    'on a cheaper model, searches the repo and the web for you, and returns a tight findings summary instead',
    'of flooding your context with raw file dumps. State the breadth you want in the prompt — "quick",',
    '"medium", or "very thorough". Use it to stay oriented on large repos without burning tokens.',
    'OTHER SUBAGENTS (same Task tool, all Sonnet + advisory — they report, they do NOT edit files):',
    '  • `docs` — look up EXTERNAL library/framework/API documentation (this repo\'s own docs are `explore`);',
    '  • `review` — a second pass on a diff + intent for bugs, removed behavior, and convention drift;',
    '  • `debug` — trace a failure (error/stack/failing test) to its root cause and fix site;',
    '  • `test` — run the repo\'s verification and get back a diagnosis instead of raw logs.',
    'Reach for `review` and `test` especially when you implement a direct build yourself (FAST PATH).',
    'WEB ACCESS: you have WebSearch and WebFetch — use them to check current library docs, latest versions, and',
    'recent changes rather than relying on memory; the codebase is authoritative for THIS repo, the web for the',
    'outside world.',
    '',
    'WHY YOU GRILL — THE PLAN IS A HANDOFF, NOT YOUR OWN BUILD NOTES: you do NOT build the full plan',
    'yourself. A FRESH, CONTEXT-LESS engine agent — ZERO memory of this conversation — will REVIEW your',
    'specs and then IMPLEMENT them, seeing ONLY `/context/specs/`, the structured plan you submit, and the',
    'repo. Everything you learn by grilling that you do not WRITE DOWN is lost to it. So the interview has',
    'TWO outputs, not one: (1) the right decisions; (2) the written context a cold agent needs to build AND',
    'review the work WITHOUT you. Grill hard enough to get both. A spec only YOU could execute — because you',
    'still hold unwritten context in your head — is a FAILED spec.',
    '',
    'CALIBRATE THE INTERVIEW TO THE WORK (this is why both paths exist): depth scales with scope, risk, and',
    'reversibility — by how many always-ask classes the work genuinely touches, not a fixed script. A',
    'localized bug fix with an obvious cause: confirm the diagnosis, often ZERO formal questions, take the',
    'FAST PATH. A schema-touching, multi-track feature: the full branch-walking interview, and lock nothing',
    'unasked that is a one-way door. Do not interrogate a typo; do not one-shot a migration. Match the',
    'ceremony to the change in front of you.',
    '',
    'GRILLING PROTOCOL (applies to BOTH paths): lock the always-ask decisions before proposing — data',
    'model/schema, public API contracts, new dependencies, infrastructure/topology, cross-cutting patterns',
    '(auth, caching, state, concurrency, error-handling), one-way doors. For security/auth: surface EACH',
    'mechanism as its OWN decision. Do NOT grill about never-ask details (naming, file placement, test layout).',
    '',
    'GRILL AGAINST THE DOMAIN (this IS the planning ceremony): grilling is not just enumerating the',
    'always-ask decisions — it is a relentless interview that walks every branch of the design tree until',
    'you and the operator share ONE precise understanding. Resolve the dependencies between decisions one',
    'at a time, and for each question give your RECOMMENDED answer first, then let the operator confirm or',
    'redirect. If a question can be answered by reading the repo, read the repo instead of asking. Four',
    'moves run THROUGHOUT the conversation, not just at decision points:',
    '  • SHARPEN TERMINOLOGY — when the operator uses a vague or overloaded term, propose the precise',
    '    canonical word and pin it down ("you said \'account\' — do you mean the User or the Org? those are',
    '    different things"). When a term conflicts with the language already used in the repo or its docs,',
    '    call it out immediately rather than quietly adopting the new sense.',
    '  • STRESS-TEST WITH SCENARIOS — when domain relationships are in play, invent concrete edge-case',
    '    scenarios that force the operator to be precise about the boundaries between concepts.',
    '  • CROSS-REFERENCE WITH CODE — when the operator states how something works, check whether the code',
    '    agrees; if it does not, surface the contradiction ("the code cancels the whole Order, but you said',
    '    partial cancellation is possible — which is right?").',
    '  • CAPTURE AS YOU GO (never batch to the end) — the moment a term is sharpened or a relationship is',
    '    settled, write it down inline alongside the always-ask decisions you lock via create_decision. Put',
    '    the sharpened, canonical domain language into a GLOSSARY in /context/specs — either a `## Glossary`',
    '    section in `plan.md` or a short `/context/specs/CONTEXT.md`. Keep it a TIGHT glossary: each term in',
    '    1–2 lines saying what it IS (not what it does), plus the words to AVOID for that concept; devoid of',
    '    implementation detail. By the time you propose, the shared language is already on disk for the build',
    '    engines and the operator to read. (Architectural rationale that is hard to reverse and surprising',
    '    without context belongs in the locked decisions + the specs `## Architecture`, not the glossary.)',
    '',
    'RECOMMEND ≠ DECIDE — the failure to avoid: proposing a default is NOT the operator deciding. For every',
    'always-ask class the work touches you must do ONE of two things — never neither, never silently fold it',
    'into another decision\'s ruling: (a) ASK it via `ask_question`, lock the answer, and mark the decision',
    '`confirmedByOperator: true`; or (b) when the default is low-risk and you are confident, lock it as a',
    'decision you AUTHORED (`confirmedByOperator: false`, the default) so it still surfaces at the gate for',
    'the operator to veto. A SCOPE REDUCTION — cutting functionality, e.g. "read-only, defer the writes" — is',
    'itself an always-ask decision: ASK, do not quietly assume it. (The approval card flags every authored',
    'default so the operator sees exactly which calls they did not make — do not lean on that to skip asking',
    'the consequential ones.)',
    'ONE DECISION PER CALL: a `create_decision` ruling settles ONE always-ask call. Do NOT bundle independent',
    'calls into one ruling — auth + data model + API shape is THREE create_decision calls, not one paragraph.',
    '',
    'ASK VIA THE TOOL, NOT IN PROSE: every question you put to the operator goes through `ask_question` —',
    'NEVER ask a question in your prose reply. Put your reasoning/analysis/recommendation in prose, then pose',
    'the actual question with `ask_question({ question, header?, decisionClass?, options:[{label,description?}], allowOther? })`:',
    '  • ONE focused question per call; give 2–4 concrete `options` (the operator can also answer freely if',
    `    allowOther is true, the default). Set \`decisionClass\` when the question settles an always-ask class —`,
    `    it is EXACTLY one of (underscores, not hyphens): ${DECISION_CLASS_IDS.join(' | ')}.`,
    '  • After calling it, STOP and wait — do not ask anything else that turn. Posting the card ENDS your',
    '    turn; the operator’s answer arrives on your NEXT turn as a `<system_notification>` line carrying',
    '    their choice. One question per turn.',
    'LOCK EACH DECISION AS IT SETTLES: the moment an answer settles an always-ask decision, call',
    `\`create_decision({ decisionClass, ruling, confirmedByOperator?, title? })\` — decisionClass is EXACTLY`,
    `one of (underscores, not hyphens): ${DECISION_CLASS_IDS.join(' | ')}. Set \`confirmedByOperator: true\``,
    'ONLY when the operator\'s attached answer directly settles THIS ruling (asked and chosen); omit it (false)',
    'for a default you authored. The host coerces it to false unless an operator answer is on record, and',
    'echoes a running `confirmed`/`authored` tally back to you. It AUTO-ATTACHES the question you just asked',
    'and the operator\'s answer — do NOT restate them. Lock it BEFORE asking your next question. The call RETURNS the',
    'fully-resolved decision — its stable `id` plus the attached Q&A — so you now hold the exact stored record',
    'in context. To change a ruling later call `update_decision({ id, ruling? / title? / decisionClass? })`; to',
    'drop one call `delete_decision({ id })`. NEVER re-create to revise (that just adds a duplicate). This is',
    'what fills the decision record (below); submit_plan reads these decisions, so you do NOT pass them to it.',
    'YOU ALREADY HAVE THE RECORD: because every create/update/delete_decision return is in your context, the',
    'whole working set is too — do NOT call get_decision_record to "double-check" before submit_plan. That tool',
    'is RECOVERY ONLY: use it solely if this session was resumed/compacted and the earlier returns are gone.',
    '',
    'THE /context SHARED FOLDER: `/context` is a durable, per-thread space OUTSIDE the repo, shared with the',
    'build sessions. THREE buckets, split by who authors them:',
    '  • `/context/specs/` — HAND-AUTHORED by you, live as you work (NOT in one burst at the end), as CONTEXT',
    '    for the operator + the build engines. (The build orchestrates off the structured plan you submit; these',
    '    files are the HANDOFF a fresh, context-less engine reads to build AND review — capture the WHY and the',
    '    domain knowledge you extracted by grilling, especially in each section\'s `## Context`, not just the WHAT.)',
    '    MULTI-FILE — follow PLAN.MD STRUCTURE below:',
    '      – `plan.md` — the INDEX (goal · overview · architecture/mermaid · the ordered track list);',
    '      – `sections/NN-<slug>.md` — ONE file per track (its goal, context, steps, validation);',
    '      – `data-model.md` — cross-cutting schema/migrations/ER diagram, when the work touches the schema.',
    '    The operator watches these fill in; revise as decisions change things.',
    '    CADENCE — write a track\'s `sections/NN.md` (and grow the `plan.md` index) the MOMENT its shape settles',
    '    (its files are open and its decisions are logged), BEFORE you scope the next — the same rhythm as',
    '    create_decision. By the time the last decision locks the spec files are near-complete. A STEP you have',
    '    fully investigated but not yet written as an execute-ready `#### N.M` block is unfinished work. The',
    '    `# <goal>` H1 may be revised until you submit.',
    '  • `/context/generated/` — SYSTEM-GENERATED and READ-ONLY (a read-only mount; you cannot write it). The',
    '    decisions you lock via `create_decision` are rendered here as `decision-record.md`, live, on every call.',
    '    Do NOT try to author or edit anything here — it is maintained for you through your tool calls.',
    '  • `/context/artifacts/` — OUTPUTS for the human: preview HTML, screenshots, reports (never the repo).',
    'Treat the repo (`/workspace`) as READ-ONLY until a build is approved — never modify it while planning;',
    'write to `/context/specs` (or `/context/artifacts`) instead.',
    '',
    'TWO PATHS — choose based on size/risk:',
    '',
    'FULL PATH — submit_plan (multi-track build run by the deterministic driver). Use for anything beyond',
    'a small, localized change. You author the ENTIRE plan up front — every track AND all of its steps, each',
    'step execute-ready — during the conversation. There is NO later "step planning" step: the detail you',
    'write IS what the build runs. By the time you call submit_plan, `/context/specs/plan.md` is already',
    'complete (per CADENCE above).',
    '',
    'PLAN DEPTH (applies to each PHASE brief): a step must be buildable to the keystroke by a fresh engine',
    'turn that will NOT ask you anything — aim at the altitude of a senior engineer\'s implementation diff, NOT',
    'a design summary. Each step brief covers:',
    '  • touch points — every file the step changes, each anchored to an EXACT `path:line` you copied from a',
    '    Read/Grep (never an estimate or "~line N"), with the symbol that lives at that line;',
    '  • concrete changes — for any non-trivial edit, the actual change, not prose: the new signature/type, a',
    '    short code skeleton (the 3–8 lines that matter), and any ordering/safety constraint (e.g. "set the',
    '    failure field BEFORE the early return"). A builder must not have to re-derive the code. Trivial edits',
    '    (a one-line add, a stub→real call) stay one sentence — do not pad them;',
    '  • verify — the ACTUAL command(s) that prove the step works (test file/path, build or lint cmd) plus any',
    '    non-obvious gotcha (must rebuild native, won\'t hot-reload, needs a generated migration). "Unit-test',
    '    it" is a goal, not verification. Let detail follow difficulty — the hard step gets the depth.',
    '',
    'PLAN.MD STRUCTURE — the specs are MULTI-FILE; author them so build + operator read them the same way:',
    '    /context/specs/plan.md  — the INDEX:',
    '        # <one-line goal>          (the `goal` arg, verbatim)',
    '        ## Overview                (intent · stack · constraints · out of scope)',
    '        ## Architecture            (OPTIONAL — mermaid / data flow / the moving parts)',
    '        ## Decisions               (one line: "see decision-record.md" — generated; do not duplicate)',
    '        ## Tracks                  (ordered list; each links its file + 1-line goal + type, e.g.',
    '                                    "1. [Backend](sections/01-backend.md) — <slice> · type: backend")',
    '    /context/specs/data-model.md — cross-cutting schema/migrations/ER mermaid (only if schema changes)',
    '    /context/specs/sections/NN-<slug>.md — ONE per track:',
    '        # Track N — <title>',
    '        ## Goal                    (the demo-able slice, 1–2 lines)',
    '        ## Context                 (what exists today + EXACT path:line anchors + which decisions shaped it)',
    '        ## Steps',
    '        #### N.M — <step title>    (the body is the step brief — PLAN DEPTH above)',
    '        ## Validation              (the demo-able outcome that closes the track)',
    '  These files are CONTEXT; the AUTHORITATIVE structured tracks/steps are the `submit_plan` ARGS (below) —',
    '  the build orchestrates off those. The arg `brief` is the execute instruction (PLAN DEPTH); the section',
    '  file is the same work as readable narrative + diagrams (need not be byte-identical). State hard step',
    '  ORDERING inline ("N.2 needs N.1\'s migration"); do NOT author concurrency/grouping — how steps pack into',
    '  sessions is decided downstream. Do NOT write a "review" section: track self-review is a FIXED automatic',
    '  stage selected by the track\'s TYPE; `## Validation` says what success looks like, not how it is reviewed.',
    '',
    '`submit_plan` does NOT author the plan and does NOT post the approval card — it REQUESTS AN AUTOMATED',
    'CODEX REVIEW of the plan you authored. Codex reads `/context/specs/` and grades your tracks + steps; the',
    'review runs in the background (it can take several minutes). When it finishes I relay its findings to you',
    'as a "Codex review" message. ADDRESS each finding — APPLY it (revise the specs + the structured plan), or',
    'PUSH BACK with reasoning — then either call `submit_plan` AGAIN to re-review the revised plan, or call',
    '`finalize_plan` to send the reviewed plan to the operator. Do NOT call `finalize_plan` until I have',
    'relayed the Codex findings — while a review is still running it is refused. Only `finalize_plan` posts the approval card;',
    'the operator is the FINAL GATE before the build runs, and they see any findings you pushed back on. (The',
    'review is bounded to a few rounds; after the cap, finalize_plan over the remaining findings.) Ensure',
    '`/context/specs/plan.md` is complete and all always-ask decisions are locked via create_decision FIRST,',
    'then call submit_plan with:',
    '  - goal: the one-line goal of the whole thread (verbatim the plan.md `# <H1>`; becomes the thread title)',
    '  - overview: intent + stack + constraints',
    '  - tracks: the ordered tracks, each `{ title, type, steps: [{ title, brief }] }`. `type` = the track\'s',
    '    scope — backend | frontend | docs | testing | analytics | infra (or another short label if none fit);',
    '    it SELECTS the review agents. `brief` = the execute-ready step instruction (PLAN DEPTH). ≥1 step/track.',
    '  (No `decisions` arg — submit_plan reads the decisions you locked via create_decision. Pass `decisions`',
    '   ONLY to authoritatively replace the whole set, e.g. after request-changes pruned some.)',
    'TRACK & STEP GRANULARITY: a TRACK is a SCOPE-TYPED layer that ends in a self-review/auto-fix pass — a',
    'slice you could demo or review on its own, and its `type` (backend/frontend/docs/testing/analytics/infra)',
    'selects the reviewers. Prefer FEW, BROAD tracks (≈1–4 for a typical feature); do NOT split one scope into',
    'several tracks (backend is ONE track, not one per file). A STEP is one focused unit an engineer finishes',
    'in one sitting — GROUP naturally-related edits (a column + its DTO; a component + its hook) into one step;',
    'do NOT make a step per file. Prefer ~2–5 steps per track; a tiny track is ONE step.',
    'SELF-CHECK before submit_plan (from context — no get_decision_record needed): every applicable always-ask',
    'decision locked? does each track have a `type`?',
    'could a fresh engine turn build EACH STEP from its `#### N.M` brief ALONE — exact `path:line` anchors,',
    'concrete code/signatures for the hard edits, runnable verification — with ZERO further questions to you?',
    'is it grounded in files you actually opened (not guessed)? is the `goal` a single clear line? Do NOT add',
    'an "investigate the codebase" track — tracks are real build work.',
    '',
    'FAST PATH — start_direct_build (a small, localized change you implement YOURSELF, no tracks/steps).',
    'Use only when the change is small and well-understood and touches NO uncovered always-ask decision.',
    'Args: { summary, changeOutline?: string[], decisions? }. summary = what you will change and why;',
    'changeOutline = a few bullet lines of the concrete edits. This posts a lightweight approval card. If it',
    'trips an uncovered always-ask decision it is refused — lock that decision first or use submit_plan.',
    'AFTER the operator approves, you will be asked (autonomously) to implement it: make the edits in',
    '`/workspace`, verify them, then call `finalize_build` to commit, review, and open the PR.',
    '',
    'SANDBOX RUNTIME: your sandbox can be restarted between turns (idle reaps, crashes, restarts). Never',
    'assume a server or background process you started in a previous turn is still running — verify it is',
    'up (curl/health-check) and restart it if needed before relying on it.',
    '',
    'ACT WITH CARE, REPORT TRUTHFULLY: the approval gate is your safety net, not a substitute for judgment.',
    'The hard-to-reverse, outward-facing actions are `finalize_build` / `dispatch_build` (they commit code and',
    'open a real PR) and `finalize_plan` (it posts the operator approval card) — take them only when the work',
    'is genuinely ready, never to "move things along". When implementing a direct build, before you overwrite',
    'or delete anything in `/workspace`, look at what is actually there: if it contradicts what you expected,',
    'or you did not create it, surface that instead of plowing ahead. Report outcomes as they truly are — if a',
    'verification command fails, say so and show the output; if you skipped a check, say that; when something',
    'is done and verified, state it plainly without hedging. Never report a build, test, or fix as succeeding',
    'on the strength of what you intended rather than what you actually observed.',
  ].join('\n');

  /**
   * Register the leader-only boot crash-recovery sweeps. These are SINGLETON repair operations (they
   * reset `turn_active` flags and re-drive dropped deliveries), so they must run ONLY on the instance
   * that holds leadership — never on a standby that booted while another instance is still live. The
   * drain-then-release invariant guarantees promotion happens only after any predecessor has fully
   * drained, so the sweeps never collide with in-flight work. `onPromote` fires immediately if this
   * instance is already leader.
   */
  onApplicationBootstrap(): void {
    this.leaderBootSub = this.election.onPromote(() => this.runLeaderBootSweeps());
  }

  onApplicationShutdown(): void {
    this.leaderBootSub?.unsubscribe();
  }

  /** The leader-only boot sweeps, run ONCE on first promotion. Each step is independently best-effort. */
  private async runLeaderBootSweeps(): Promise<void> {
    // Guard against a mid-life re-promote (lock lost+regained on a blip): re-running resetAllTurnActive
    // would clear `turn_active` for turns CURRENTLY executing on this process, making them look idle.
    if (this.bootSweepsDone) return;
    this.bootSweepsDone = true;

    // 1) Clear any `turn_active` flag left set by a crash mid-turn — no conversational turn survives a
    //    process restart, so a still-true flag is stale and would suppress the thread's "needs you" dot.
    try {
      const reset = await this.store.resetAllTurnActive();
      if (reset > 0) this.logger.log(`Leader: cleared stale turn_active on ${reset} thread(s)`);
    } catch (err) {
      this.logger.warn(`turn_active reconciliation failed: ${err}`);
    }

    // 2) Re-deliver any question the operator ANSWERED (durably stamped) but whose delivery turn a host
    //    crash dropped before it reached the brain. Drives each straight through the serialized
    //    `handleChatTurn`; the turn stamps `deliveredAt` on success → at-least-once across restarts.
    try {
      const pending = await this.store.findUndeliveredAnsweredQuestions();
      if (pending.length > 0) {
        this.logger.log(`Leader: re-delivering ${pending.length} answered-but-undelivered question(s)`);
        for (const q of pending) {
          const stimulus = bootDeliveryStimulus(q);
          void this.handleChatTurn(stimulus).catch((err) =>
            this.logger.warn(`boot re-delivery failed for thread=${q.threadId}: ${err}`),
          );
        }
      }
    } catch (err) {
      this.logger.warn(`question-delivery reconciliation failed: ${err}`);
    }

    // 3) Plan-review reconciliation (same at-least-once shape): re-run any review whose Codex turn was in
    //    flight when the host died (`running`), and re-deliver any completed review whose delivery turn the
    //    crash dropped (`delivered_at` null). `deliverReviewFindings` is idempotent on the visible message.
    try {
      const incomplete = await this.planReview.findIncompleteReviews();
      const undelivered = await this.planReview.findUndeliveredReviews();
      if (incomplete.length || undelivered.length) {
        this.logger.log(
          `Leader: reconciling ${incomplete.length} in-flight + ${undelivered.length} undelivered plan-review(s)`,
        );
      }
      for (const r of incomplete) {
        void this.runAndDeliverReview(r.id).catch((err) =>
          this.logger.warn(`boot plan-review re-run failed for review=${r.id}: ${err}`),
        );
      }
      for (const r of undelivered) {
        void this.deliverReviewFindings(r.id).catch((err) =>
          this.logger.warn(`boot plan-review re-delivery failed for review=${r.id}: ${err}`),
        );
      }
    } catch (err) {
      this.logger.warn(`plan-review reconciliation failed: ${err}`);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Handle one chat stimulus in a scoping thread. SERIALIZED per thread: if a turn is already running for
   * this thread (the operator sent a follow-up while it was thinking), this one queues behind it and runs
   * after — never two concurrent engine turns resuming the same session id. Runs an in-sandbox engine
   * turn with the 6 host-side tools; the session is resumed across turns.
   */
  async handleChatTurn(stimulus: ChatStimulus): Promise<void> {
    // Drain gate: once this instance is draining (SIGTERM), accept NO new turns. Operator turns are
    // already rejected with 503 at the surface; this catches internal/boot re-delivery callers so the
    // in-flight set can actually quiesce. A no-op (not a throw) — internal callers are fire-and-forget.
    if (this.election.getState() === 'draining') return;
    const key = `${stimulus.orgId}:${stimulus.threadId}`;
    const prev = this.turnQueues.get(key) ?? Promise.resolve();
    // Chain after any in-flight turn (swallow its error so a failed turn doesn't break the queue).
    const next = prev.catch(() => undefined).then(() => this.runChatTurn(stimulus));
    // Track this as the tail; clear the map entry once it settles IF nothing newer queued behind it.
    this.turnQueues.set(
      key,
      next.finally(() => {
        if (this.turnQueues.get(key) === next) this.turnQueues.delete(key);
      }),
    );
    return next;
  }

  /**
   * Await all in-flight turns to finish, bounded by `graceMs`. Returns `true` if everything drained
   * cleanly, `false` if the grace cap was hit (the caller then lets the process exit; over-cap turns die
   * with it and cold-resume on the next leader). New turns are already blocked (drain gate above), so the
   * current `turnQueues` snapshot is the complete in-flight set.
   */
  async drainInFlight(graceMs: number): Promise<boolean> {
    const tails = [...this.turnQueues.values()].map((p) => p.catch(() => undefined));
    if (tails.length === 0) return true;
    this.logger.log(`Drain: awaiting ${tails.length} in-flight turn(s) (grace ${graceMs}ms)`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), graceMs);
    });
    const done = Promise.all(tails).then(() => 'done' as const);
    const result = await Promise.race([done, timeout]);
    if (timer) clearTimeout(timer);
    return result === 'done';
  }

  /**
   * One chat turn — marks the thread "actively working" for its WHOLE duration (including the ~30s first
   * provisioning), so the sidebar "needs you" dot clears while we work and returns the moment control
   * comes back to the operator (every early return below still hits the `finally`). Best-effort flag
   * writes never block the turn. Delegates the actual turn to `runChatTurnInner`.
   */
  private async runChatTurn(stimulus: ChatStimulus): Promise<void> {
    await this.store.setTurnActive(stimulus.threadId, true).catch(() => undefined);
    try {
      await this.runChatTurnInner(stimulus);
    } finally {
      await this.store.setTurnActive(stimulus.threadId, false).catch(() => undefined);
    }
  }

  /** The turn body (provision → attach → in-sandbox engine turn → stream + persist). Serialized by the
   *  `handleChatTurn` queue above — never invoked concurrently for the same thread. */
  private async runChatTurnInner(stimulus: ChatStimulus): Promise<void> {
    // TYPED-ANSWER LINKAGE — operator-authored turns ONLY: if the operator answered an outstanding
    // `ask_question` card in PROSE (composer) rather than clicking it, stamp that card answered so
    // `create_decision` can auto-attach the Q&A. SYNTHETIC turns must NOT run this — a seed answer-delivery
    // turn's card is already stamped by the endpoint (no-op anyway), and a harness plan-review delivery
    // turn's body is the Codex findings, which must never be stamped onto a pending unanswered question.
    if (isOperatorAuthored(stimulus)) {
      await this.linkTypedQuestionAnswer(stimulus);
    }

    // Human-input gate delivery: if this thread's gate points at a now-ANSWERED, not-yet-DELIVERED question
    // (the answer was stamped by the endpoint, the prose path above, or persisted before a crash), THIS turn
    // is its delivery turn — INCLUDING a SEED-authored answer-delivery turn (the `/answer-question` endpoint
    // delivers via `seedSystemNotification`), so this capture is UNCONDITIONAL. We stamp `deliveredAt` + clear
    // the pointer ONLY on the successful tail below — never on an early return / error — so a failed turn
    // re-delivers (at-least-once). Correctness keys off the durable gate, not which path triggered the turn.
    let deliveredQuestionId: string | null = null;
    const awaitingId = await this.store.awaitingQuestionId(stimulus.threadId);
    if (awaitingId) {
      const card = await this.store.getQuestionCard(stimulus.threadId, awaitingId);
      if (card?.answer != null && card.deliveredAt == null) deliveredQuestionId = awaitingId;
    }

    // Lazily provision the thread's sandbox on its FIRST turn — the live create/seed paths insert bare
    // thread rows (no sandbox/branch). Subsequent turns no-op (the row already exists). Tell the operator
    // we're setting up so the first turn isn't a silent ~30s wait while we clone + start a container.
    const alreadyProvisioned = await this.lifecycle.findSandbox(stimulus.threadId, stimulus.orgId);
    if (!alreadyProvisioned) {
      await this.say(stimulus, 'Setting up an isolated workspace for this thread — one moment…');
    }
    try {
      const provisioned = await this.lifecycle.ensureProvisioned(stimulus.threadId, stimulus.orgId);
      if (!provisioned) {
        await this.say(stimulus, 'This thread is closed — start a new one to keep working.');
        return;
      }
    } catch (err) {
      if (err instanceof ProvisioningNotReadyError) {
        await this.say(stimulus, err.message);
      } else {
        this.logger.error(`provisioning failed for thread=${stimulus.threadId}: ${err}`);
        await this.say(
          stimulus,
          `I couldn't set up a workspace for this thread. (${String(err).slice(0, 200)})`,
        );
      }
      return;
    }

    // (Re-)attach a live container against the thread's durable worktree. Returns null only if the
    // thread has no sandbox row (just provisioned above, so unexpected) or is closed.
    const ensured = await this.lifecycle.ensureContainer(stimulus.threadId, stimulus.orgId);
    if (!ensured) {
      this.logger.warn(
        `No sandbox for thread=${stimulus.threadId} team=${stimulus.orgId} — cannot run in-sandbox turn`,
      );
      await this.say(stimulus, 'Please create a thread via the web app to start a scoping session.');
      return;
    }
    const sandbox = ensured.sandbox;

    // Resolve the current session_id for this thread (resume across turns).
    const sandboxRow = await this.sandboxRows.findOne({
      where: { thread_id: stimulus.threadId, org_id: stimulus.orgId },
    });
    const sessionId = sandboxRow?.session_id ?? undefined;

    // Cold re-attach while resuming a session → the session remembers in-container state that's gone.
    // Prepend the reset notice so it re-establishes its runtime instead of trusting stale beliefs.
    let task = ensured.wasReset && sessionId ? `${SANDBOX_RESET_NOTICE}\n\n${stimulus.body}` : stimulus.body;

    // PASSIVE pipeline-milestone awareness (buffer-and-flush, NOT a push). On an OPERATOR turn — and only
    // after the provisioning guards above succeeded, so a closed/failed turn never clears the buffer
    // un-injected — atomically drain any milestones buffered while the brain was idle + the net-state
    // delta, and PREPEND a clearly-passive summary so the brain knows where the build stands. SYNTHETIC
    // (atlas-authored) turns skip the drain (runDirectBuild / startFollowUpThread must not consume the
    // buffer before the operator sees it). Best-effort: a failure here never blocks the turn.
    if (isOperatorAuthored(stimulus)) {
      const awarenessPrefix = await this.buildAwarenessPrefix(stimulus.threadId, stimulus.orgId);
      if (awarenessPrefix) task = `${awarenessPrefix}\n\n${task}`;
    }

    // Build the host-side tool dispatch table, scoped to this thread.
    const tools = this.buildTools(stimulus);

    // All turns run inside the Docker sandbox container.
    const runner: EngineRunnerPort = this.dockerRunner;

    // The thread is a live web wrapper over this in-sandbox session: stream every engine event to the web
    // AND persist the authoritative blocks (text/thinking/tool) as the durable transcript.
    const route = await this.store.route({
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      threadId: stimulus.threadId,
    });
    const channel = route.channel ?? stimulus.replyRoute.threadRef;
    const streamer = this.makeTurnStreamer(stimulus, channel);

    const sandboxKey = `brain-${stimulus.orgId}-${stimulus.repoId}-${stimulus.threadId}`;
    // Per-org Claude subscription secret (deployed); undefined locally → the in-container engine falls
    // back to CLAUDE_OAUTH_TOKEN, and throws if neither is set (never an API-key fallback).
    const auth = await this.creds.engineAuth(stimulus.orgId, 'claude');
    const runArgs: RunEngineArgs = {
      engine: 'claude',
      task,
      cwd: sandbox.worktreePath,
      systemPrompt: AgentSessionManager.SYSTEM_PROMPT,
      sandboxKey,
      ...(auth ? { auth } : {}),
      mode: 'execute', // the session manages its own read-only posture via custom plan mode
      model: AgentSessionManager.BRAIN_MODEL, // the thread brain reasons/plans — pin it to Opus
      richStream: true, // token-level deltas + thinking + tool calls/results (the brain conversation)
      ...(sessionId ? { sessionId } : {}),
      ...(sandbox.containerId
        ? { target: { containerId: sandbox.containerId, worktreeHost: sandbox.worktreePath } }
        : {}),
      toolBridge: {
        threadId: stimulus.threadId,
        tools,
      },
      onEvent: (e) => streamer.onEvent(e),
    };

    let result;
    try {
      result = await runner.run(runArgs);
    } catch (err) {
      this.logger.error(`in-sandbox turn failed for thread=${stimulus.threadId}: ${err}`);
      await streamer.finish();
      // An unresumable session is terminal for this thread — retrying re-hits the same missing transcript.
      // This is an error FOR THE OPERATOR, not Atlas: surface it as a system→operator notice (its own box,
      // not an Atlas bubble) and don't say "try again". A normal turn error stays an Atlas-voice reply.
      if (isUnresumableSessionMessage(String(err))) {
        await this.saySystemOperator(
          stimulus,
          "This thread can't continue — its engine session state is gone (this happens after an engine update or if the session home was cleared). Retrying won't help. Please start a new thread to pick this back up.",
        );
      } else {
        await this.say(stimulus, `I ran into an error — please try again. (${String(err).slice(0, 200)})`);
      }
      return;
    }

    // Persist the session_id for resume.
    if (result.sessionId && sandboxRow) {
      sandboxRow.session_id = result.sessionId;
      await this.sandboxRows.save(sandboxRow);
    }

    // Flush the durable transcript (persists any unpaired tool call + a text fallback if the turn emitted
    // no text block), then signal turn end so the client reconciles its live buffer against /messages.
    await streamer.finish(result.result);

    // SUCCESS TAIL ONLY: the brain consumed the answer this turn, so close the human-input gate — stamp
    // `deliveredAt` (so the boot sweep won't re-deliver it) and clear the pointer (compare-and-clear, so a
    // question opened DURING this turn isn't clobbered). Reached only on the happy path; every early return
    // / error above leaves the question undelivered for the next turn or the boot sweep. Best-effort.
    if (deliveredQuestionId) {
      await this.store
        .markQuestionDelivered(stimulus.threadId, deliveredQuestionId)
        .catch((err) => this.logger.warn(`markQuestionDelivered failed: ${err}`));
      await this.store
        .clearAwaitingQuestion(stimulus.threadId, deliveredQuestionId)
        .catch((err) => this.logger.warn(`clearAwaitingQuestion failed: ${err}`));
    }
  }

  /**
   * A per-turn streamer — the bridge between the in-sandbox session and the web. For each engine event it
   * (a) emits a LIVE frame to the surface (token deltas, thinking, tool calls/results) and (b) records the
   * AUTHORITATIVE blocks into the durable transcript: assistant text (`chat`), thinking (`thinking`), and
   * tool calls paired with their results by id (`tool`, with `{name,input,result,isError}` in `meta`).
   * Persists are serialized (a promise chain) to preserve transcript order; `finish` flushes any unpaired
   * tool call + a text fallback, awaits the chain so rows are durable, then emits the `turn_end` marker.
   */
  private makeTurnStreamer(
    stimulus: ChatStimulus,
    channel: string,
  ): { onEvent: (e: EngineEvent) => void; finish: (finalText?: string) => Promise<void> } {
    const threadId = stimulus.threadId;
    // The durable transcript, accumulated in event order. Persisted to `messages` ONLY at turn end — so
    // DURING the turn the resumable `LiveTurnStore` is the SOLE source of the in-flight blocks. This is
    // what prevents a double-render on reconnect: if completed blocks were persisted mid-turn, a
    // reconnecting client would see them BOTH from `/messages` AND from the live snapshot (which holds the
    // whole cumulative turn). DB-on-completion-only mirrors the rs-crm-app email-summary pattern.
    //
    // Each block carries `emittedAt` — the wall-clock moment it streamed. Persisting at turn end would
    // otherwise stamp the whole batch with the turn-END time, sorting it AFTER a follow-up the operator
    // sent mid-turn (persisted at its real send time) — the bug where a later question jumps to the top of
    // the turn. Stamps are forced strictly-monotonic so blocks never tie within a turn (ms granularity).
    type DurableBlock = {
      kind: string;
      text?: string;
      meta?: Record<string, unknown>;
      toolId?: string;
      done?: boolean;
      emittedAt: Date;
    };
    const blocks: DurableBlock[] = [];
    let lastEmitMs = 0;
    const stamp = (): Date => {
      lastEmitMs = Math.max(Date.now(), lastEmitMs + 1);
      return new Date(lastEmitMs);
    };

    return {
      onEvent: (e: EngineEvent) => {
        // LIVE + RESUMABLE: the store fans the frame AND holds the cumulative turn for snapshot-on-connect.
        this.liveTurns.push(channel, threadId, e);
        switch (e.kind) {
          case 'text':
            // `parentToolUseId` (set only for subagent blocks) is stamped into meta so the web can peel
            // subagent activity out of the main transcript into its own sub-page.
            if (e.text.trim())
              blocks.push({
                kind: 'chat',
                text: e.text,
                emittedAt: stamp(),
                ...(e.parentToolUseId ? { meta: { parentToolUseId: e.parentToolUseId } } : {}),
              });
            break;
          case 'thinking':
            if (e.text.trim())
              blocks.push({
                kind: 'thinking',
                text: e.text,
                emittedAt: stamp(),
                ...(e.parentToolUseId ? { meta: { parentToolUseId: e.parentToolUseId } } : {}),
              });
            break;
          case 'tool_use': {
            const toolId = e.id || `tool-${blocks.length}`;
            blocks.push({
              kind: 'tool',
              toolId,
              done: false,
              meta: {
                // `id` is persisted (the durable row otherwise drops it) so the web can join a subagent's
                // child blocks (`meta.parentToolUseId`) back to THIS spawning Task block.
                id: toolId,
                name: e.name,
                input: e.input ?? null,
                result: null,
                isError: false,
                ...(e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : {}),
              },
              emittedAt: stamp(),
            });
            break;
          }
          case 'tool_result': {
            // Pair with the newest still-open tool block (preserving interleaved order with text/thinking).
            for (let i = blocks.length - 1; i >= 0; i--) {
              const b = blocks[i];
              if (b.kind === 'tool' && !b.done && (b.toolId === e.id || !e.id)) {
                b.done = true;
                b.meta = { ...b.meta, result: e.result ?? null, isError: e.isError ?? false };
                break;
              }
            }
            break;
          }
          default:
            break; // session / result / *_delta — not part of the durable transcript
        }
      },
      finish: async (finalText?: string) => {
        // Fallback: a turn that emitted NO text block — keep the final summary so the reply isn't lost.
        if (!blocks.some((b) => b.kind === 'chat') && finalText && finalText.trim()) {
          blocks.push({ kind: 'chat', text: finalText.trim(), emittedAt: stamp() });
        }
        // Persist the whole transcript in order (each row stamped with its emission time so an
        // interleaved mid-turn user message sorts correctly), THEN signal turn end (so the client's
        // refetch sees it before the live buffer is cleared — no gap, no double-render).
        for (const b of blocks) {
          await this.store
            .appendBlock(threadId, {
              kind: b.kind,
              createdAt: b.emittedAt,
              ...(b.text != null ? { text: b.text } : {}),
              ...(b.meta ? { meta: b.meta } : {}),
            })
            .catch((err) => this.logger.warn(`appendBlock failed for thread=${threadId}: ${err}`));
        }
        this.liveTurns.end(channel, threadId); // fans turn_end + drops the in-flight buffer
      },
    };
  }

  // ── Host-side tool impls ───────────────────────────────────────────────────────────────────────

  /**
   * Build the 6 tool impls for a chat turn, all scoped to the stimulus's thread/team/project.
   */
  buildTools(stimulus: ChatStimulus): Record<string, ToolImpl> {
    // CREATE a decision (shared by `create_decision` and the deprecated `log_decision` alias). Auto-attaches
    // the question the operator just answered — sourced AUTHORITATIVELY from the thread's human-input gate
    // pointer (no "latest answered card" race), persists with a fresh stable id, re-renders the generated
    // record, and returns the FULLY-RESOLVED decision (id + attached Q&A) — so the brain holds ground truth
    // in context and never needs a read-back before submit_plan.
    const createDecision: ToolImpl = async (args) => {
      const envelope = missingArgsEnvelope(args);
      if (envelope) return envelope;
      const decisionClass = asDecisionClass(args['decisionClass']);
      const ruling = String(args['ruling'] ?? '').trim();
      if (!decisionClass) {
        return {
          ok: false,
          reason:
            'decisionClass must be one of: data_model | api_contract | dependency | infrastructure | ' +
            'cross_cutting | one_way_door',
        };
      }
      if (!ruling) return { ok: false, reason: 'ruling is required' };

      const answeredId = await this.store.awaitingQuestionId(stimulus.threadId);
      const answeredCard = answeredId
        ? (await this.store.getQuestionCard(stimulus.threadId, answeredId)) ?? undefined
        : undefined;
      const hasAnswer = answeredCard?.answer != null;
      // PROVENANCE: `confirmedByOperator` is true ONLY if the brain asserts it AND an operator answer is
      // actually attached (same `hasAnswer` the Q&A auto-attach uses — never a second pointer read, so the
      // two can't disagree). Default false: an unasked default lands as Atlas-authored, surfacing at the gate.
      const confirmedByOperator = args['confirmedByOperator'] === true && hasAnswer;
      const title =
        String(args['title'] ?? '').trim() ||
        deriveDecisionTitle(hasAnswer ? answeredCard!.question : ruling);
      const { decision, all } = await this.store.createDecision(stimulus.threadId, {
        decisionClass,
        title,
        ruling,
        confirmedByOperator,
        ...(hasAnswer && answeredCard!.question ? { question: answeredCard!.question } : {}),
        ...(hasAnswer ? { answer: answeredCard!.answer } : {}),
      });
      if (answeredId && hasAnswer) {
        await this.store.updateCardMessage(stimulus.threadId, answeredId, { loggedDecision: true });
      }
      await this.writeDecisionRecordMd(stimulus.threadId, stimulus.orgId, all);
      // Echo the running provenance balance so the brain sees how much it has actually CONFIRMED vs authored.
      const confirmedCount = all.filter((d) => d.confirmedByOperator).length;
      return {
        ok: true,
        decision,
        total: all.length,
        provenance: { confirmed: confirmedCount, authored: all.length - confirmedCount },
      };
    };

    return {
      get_pipeline_state: async (_args) => {
        return this.driverStore.getPipelineState(stimulus.threadId, stimulus.orgId);
      },

      get_decision_record: async (_args) => {
        const record = await this.driverStore.getDecisionRecord(stimulus.threadId);
        if (record) return record;
        // No proposal yet — surface the working set logged so far so the brain can see what it has locked.
        const pending = await this.store.pendingDecisions(stimulus.threadId);
        return { status: 'drafting', decisions: pending };
      },

      recall: async (args) => {
        const query = String(args['query'] ?? stimulus.body);
        try {
          const facts = await this.memory.recall(query, {
            scopes: [`project:${stimulus.repoId}`, `team:${stimulus.orgId}`],
            orgId: stimulus.orgId,
            limit: 8,
          });
          return facts.map((f) => ({ fact: f.fact, scope: f.scope }));
        } catch (err) {
          this.logger.debug(`recall failed: ${err}`);
          return [];
        }
      },

      remember: async (args) => {
        const fact = String(args['fact'] ?? '').trim();
        if (!fact) return { stored: false, reason: 'empty fact' };
        const scope = String(args['scope'] ?? `project:${stimulus.repoId}`);
        try {
          await this.memory.remember({
            fact,
            scope,
            orgId: stimulus.orgId,
            assertedBy: stimulus.author.id,
          });
          return { stored: true };
        } catch (err) {
          return { stored: false, reason: String(err) };
        }
      },

      ask_question: async (args) => {
        const question = String(args['question'] ?? '').trim();
        if (!question) return { ok: false, reason: 'question is required' };
        const options = normalizeQuestionOptions(args['options']);
        const decisionClass = asDecisionClass(args['decisionClass']);
        const header = String(args['header'] ?? '').trim();
        const questionId = `q-${randomUUID()}`;
        const card = webQuestionCard({
          threadId: stimulus.threadId,
          questionId,
          question,
          ...(header ? { header } : {}),
          ...(decisionClass ? { decisionClass } : {}),
          options,
          allowOther: args['allowOther'] !== false,
        });
        // Open the durable human-input gate ATOMICALLY: persist the card row + point the thread's
        // `awaiting_question_id` at it in one transaction (the surface `post` path does NOT persist
        // `messages.card`; the card renders on the turn-end refetch). Refused if a question is already
        // open, so the brain can't stack questions. The brain STOPS after asking and waits — the asking
        // turn ends cleanly (async gate), the answer arrives on a later (delivery) turn.
        const opened = await this.store.openQuestion(stimulus.threadId, {
          ts: questionId,
          text: question,
          card: card as unknown as Record<string, unknown>,
        });
        if (!opened.ok) {
          return {
            ok: false,
            reason: opened.alreadyOpen
              ? 'A question is already awaiting the operator’s answer — wait for it before asking another.'
              : 'Could not open the question (thread not found).',
          };
        }
        return {
          ok: true,
          questionId,
          message:
            'Question posted to the operator as a card. Stop and wait for their answer — do not ask ' +
            'anything else this turn. When their answer settles an always-ask decision, call create_decision.',
        };
      },

      create_decision: createDecision,
      // Deprecated alias: a session resumed mid-grill (session_id persists across turns) may still emit
      // the old name — keep it working so it doesn't fail with "No such tool". Drop once no live session
      // references it. Not advertised in the prompt's tool list (the model should prefer create_decision).
      log_decision: createDecision,

      update_decision: async (args) => {
        const envelope = missingArgsEnvelope(args);
        if (envelope) return envelope;
        const id = String(args['id'] ?? '').trim();
        if (!id) return { ok: false, reason: 'id is required' };
        // Validate decisionClass when present — an unrecognized class would persist but then be silently
        // dropped by the record renderer's class grouping. ruling/title are free text.
        const patch: Partial<Pick<Decision, 'ruling' | 'title' | 'decisionClass' | 'confirmedByOperator'>> =
          {};
        if (args['confirmedByOperator'] !== undefined) {
          // Promoting a default to operator-confirmed requires evidence: an operator answer must be attached
          // NOW (same rule as create_decision). A bare `true` with no answer on record coerces to false, so
          // confirmation is never asserted without a Q&A linkage. Demotion to false is always allowed.
          const wantsConfirm = args['confirmedByOperator'] === true;
          if (wantsConfirm) {
            const answeredId = await this.store.awaitingQuestionId(stimulus.threadId);
            const answeredCard = answeredId
              ? await this.store.getQuestionCard(stimulus.threadId, answeredId)
              : null;
            patch.confirmedByOperator = answeredCard?.answer != null;
          } else {
            patch.confirmedByOperator = false;
          }
        }
        if (args['decisionClass'] !== undefined) {
          const decisionClass = asDecisionClass(args['decisionClass']);
          if (!decisionClass) {
            return {
              ok: false,
              reason:
                'decisionClass must be one of: data_model | api_contract | dependency | infrastructure | ' +
                'cross_cutting | one_way_door',
            };
          }
          patch.decisionClass = decisionClass;
        }
        if (args['ruling'] !== undefined) {
          const ruling = String(args['ruling'] ?? '').trim();
          if (!ruling) return { ok: false, reason: 'ruling cannot be blank' };
          patch.ruling = ruling;
        }
        if (args['title'] !== undefined) {
          const title = String(args['title'] ?? '').trim();
          if (!title) return { ok: false, reason: 'title cannot be blank' };
          patch.title = title;
        }

        const result = await this.store.updateDecision(stimulus.threadId, id, patch);
        if (!result) {
          const pending = await this.store.pendingDecisions(stimulus.threadId);
          return { ok: false, reason: `no decision with id "${id}"`, knownIds: pending.map((d) => d.id) };
        }
        await this.writeDecisionRecordMd(stimulus.threadId, stimulus.orgId, result.all);
        return { ok: true, decision: result.decision, total: result.all.length };
      },

      delete_decision: async (args) => {
        const envelope = missingArgsEnvelope(args);
        if (envelope) return envelope;
        const id = String(args['id'] ?? '').trim();
        if (!id) return { ok: false, reason: 'id is required' };
        const { removed, all } = await this.store.deleteDecision(stimulus.threadId, id);
        if (!removed) {
          return { ok: false, reason: `no decision with id "${id}"`, knownIds: all.map((d) => d.id) };
        }
        await this.writeDecisionRecordMd(stimulus.threadId, stimulus.orgId, all);
        return { ok: true, removed: id, remainingIds: all.map((d) => d.id) };
      },

      submit_plan: async (args) => {
        const overview = String(args['overview'] ?? '').trim();
        // The one-line goal of the whole thread — the SAME text Atlas writes as plan.md's `# <H1>`.
        // Becomes the thread title (durable + live `thread_meta` frame, see requestApprovalAndAct).
        const goal = String(args['goal'] ?? '').trim();
        // Decisions are LOCKED incrementally during grilling (create_decision → pending_decisions). Source
        // them from the working set; an explicit `decisions` arg, if given, is an authoritative override.
        const decisions =
          args['decisions'] != null
            ? normalizeDecisions(args['decisions'])
            : await this.store.pendingDecisions(stimulus.threadId);
        // Atlas authors the FULL plan up front: each track carries its ordered step list (title +
        // keystroke-level brief). The steps LOCK here (persistPlan) so the driver skips its JIT plan
        // turn. The rich prose companion still lives in `/context/specs/plan.md`.
        const tracks = normalizeTracks(args['tracks']);
        const trackTitles = tracks.map((s) => s.title);
        const trackTypes = tracks.map((s) => s.type);
        const stepsByTrack = tracks.map((s) => s.steps);

        if (!overview || !goal || tracks.length === 0) {
          return { ok: false, reason: 'overview, goal, and at least one track are required' };
        }
        if (tracks.some((s) => s.steps.length === 0)) {
          return {
            ok: false,
            reason: 'each track must have at least one step (each step needs a title and a brief)',
          };
        }

        // Ensure there's an open scoping job on this thread.
        const jobId = await this.ensureJob(stimulus, overview, 'feature');

        // Persist the plan as `plan_review` (NOT `awaiting_approval`): submit_plan REQUESTS a Codex
        // review, it does NOT post the approval card. Decoupling persistence from approval-readiness is
        // what lets the review run async without the thread looking like it's awaiting the operator.
        const { thread: job, decisionRecordId } = await this.store.persistPlan({
          orgId: stimulus.orgId,
          repoId: stimulus.repoId,
          threadId: jobId,
          title: goal,
          kind: 'feature',
          overview,
          decisions,
          trackTitles,
          trackTypes,
          stepsByTrack,
          status: 'plan_review',
        });

        // persistPlan retitled the thread to a short label (`job.title`). Repaint the open UI now.
        this.surface.emitThreadMeta?.(stimulus.repoId, stimulus.threadId, job.title ?? goal);

        // ── R4: async Codex plan review ────────────────────────────────────────────────────────
        // Open a review round (renders + persists the durable `plan_reviews` row); the Codex turn runs
        // in the BACKGROUND (5-30 min) and its findings are delivered to this session in a later,
        // server-initiated turn. This tool returns immediately. Bounded by the round cap.
        // Give the reviewer the operator's INTENT — the goal + the originating ticket (when the thread was
        // promoted from one) — so it judges whether the plan ACHIEVES what was asked, not just internal
        // consistency. Ticket fetch is best-effort.
        const reviewTicket = await this.resolveReviewTicket(stimulus.orgId, stimulus.repoId, job.id);
        const started = await this.planReview.start({
          threadId: job.id,
          orgId: stimulus.orgId,
          decisionRecordId,
          goal,
          ...(reviewTicket ? { ticket: reviewTicket } : {}),
          overview,
          decisions,
          trackTitles,
          // Codex grades the EXECUTION detail (the authored steps), not just titles.
          stepsByTrack,
        });

        if ('capped' in started) {
          return {
            ok: true,
            jobId: job.id,
            decisionRecordId,
            message:
              `Plan persisted. The Codex review-round cap (${this.planReview.maxReviewRounds}) is reached ` +
              `— call finalize_plan to send the plan to the operator for approval. They will see any review ` +
              `findings you chose to push back on.`,
          };
        }

        await this.store
          .appendSystemEvent(
            job.id,
            "🔍 Codex is reviewing the plan — this can take a few minutes. I'll relay the findings when it's done.",
          )
          .catch((err) => this.logger.debug(`appendSystemEvent failed: ${err}`));

        // Fire-and-forget: run the review then deliver its findings (serialized by the turn queue).
        void this.runAndDeliverReview(started.reviewId);

        return {
          ok: true,
          jobId: job.id,
          decisionRecordId,
          reviewRound: started.round,
          message:
            "Plan submitted for Codex review. I'll relay the findings as a Codex message when the review " +
            'completes (it can take a few minutes); then I can revise (submit_plan again) or send it to the ' +
            'operator (finalize_plan). You do not need to do anything yet.',
        };
      },

      finalize_plan: async (_args) => {
        // The ONLY tool that posts the approval card — the operator is the final gate before the build.
        // Valid only after submit_plan persisted a plan (`plan_review`); Atlas calls it once it has
        // addressed (applied or pushed back on) the Codex review findings.
        const job = await this.store.loadJob(stimulus.threadId).catch(() => null);
        if (!job || !job.decisionRecordId) {
          return { ok: false, reason: 'No plan to finalize — call submit_plan first.' };
        }
        if (job.status === 'awaiting_approval') {
          return { ok: false, reason: 'This plan is already awaiting the operator’s approval.' };
        }
        if (job.status !== 'plan_review') {
          return {
            ok: false,
            reason: `Finalize is only valid after submit_plan (status is '${job.status}'). Call submit_plan first.`,
          };
        }
        // The async Codex review must FINISH before the plan can reach the operator. `submit_plan` flips
        // the thread to `plan_review` immediately and runs Codex in the background, so the status above
        // does NOT prove the review is done — block finalize while a round is still running. The findings
        // arrive as a "Codex review" message; the brain finalizes after addressing them.
        const running = await this.planReview.runningReview(job.id);
        if (running) {
          return {
            ok: false,
            reason:
              `The Codex plan review (round ${running.round}) is still running — wait for it to finish before ` +
              `finalizing. I will relay its findings as a Codex review message; address each, then call finalize_plan.`,
          };
        }
        const rec = await this.store.loadDecisionRecord(job.decisionRecordId);
        if (!rec) return { ok: false, reason: 'No decision record found for this plan.' };

        // Flip to the operator gate, then post the card + await the verdict in the background.
        await this.store.markAwaitingApproval(job.id);
        void this.requestApprovalAndAct(stimulus, job, job.decisionRecordId, {
          jobId: job.id,
          decisionRecordId: job.decisionRecordId,
          title: job.title ?? '',
          summary: rec.overview,
          decisions: rec.decisions,
          tracks: rec.trackTitles,
        });

        return {
          ok: true,
          jobId: job.id,
          decisionRecordId: job.decisionRecordId,
          message:
            'Plan sent to the operator for approval — the build will start automatically if approved. ' +
            'You can keep talking; if denied or changes are requested you will be told.',
        };
      },

      dispatch_build: async (_args) => {
        // GATED tool — only dispatches an already-approved (status=running) job.
        const jobId = await this.store.openJobOnThread(stimulus.threadId);
        if (!jobId) {
          return { ok: false, reason: 'No open job on this thread — call submit_plan first' };
        }
        const job = await this.store.loadJob(jobId);
        if (job.status !== 'running') {
          return {
            ok: false,
            reason: `Job ${jobId} is in status '${job.status}' — only 'running' jobs can be dispatched`,
          };
        }
        await this.dispatcher.dispatch(job);
        return { ok: true, jobId, message: 'Build dispatched.' };
      },

      start_direct_build: async (args) => {
        // FAST PATH — a small, localized change the brain implements ITSELF (no tracks/steps). Still
        // gated by a lightweight approval; on approval an autonomous implementation turn runs.
        const summary = String(args['summary'] ?? '').trim();
        if (!summary) {
          return { ok: false, reason: 'summary is required (what you will change, directly)' };
        }
        const changeOutline = Array.isArray(args['changeOutline'])
          ? args['changeOutline'].map((c) => String(c).trim()).filter(Boolean)
          : [];
        // Honor decisions locked during grilling (create_decision → pending_decisions); an explicit arg overrides.
        const decisions =
          args['decisions'] != null
            ? normalizeDecisions(args['decisions'])
            : await this.store.pendingDecisions(stimulus.threadId);

        // SAFETY GATE: "small" must NOT mean skipping an always-ask decision. Classify the change against
        // the locked decisions; an UNCOVERED always-ask class → refuse the fast path.
        const classification = await this.classifier.classify(
          { description: summary, ...(changeOutline.length ? { context: changeOutline.join('\n') } : {}) },
          { decisions },
          stimulus.orgId,
        );
        if (classification.verdict === 'ask') {
          return {
            ok: false,
            reason:
              `Not fast-path-safe — this touches an always-ask decision ` +
              `(${classification.decisionClass}): ${classification.reason} ` +
              `Lock it with the operator first, or use submit_plan for the full ceremony.`,
          };
        }

        // Persist a MINIMAL record (overview = summary, any locked decisions, NO tracks) and post the
        // lightweight approval card. The build runs only after approval (kind: 'direct').
        const jobId = await this.ensureJob(stimulus, summary, 'feature');
        const { thread: job, decisionRecordId } = await this.store.persistPlan({
          orgId: stimulus.orgId,
          repoId: stimulus.repoId,
          threadId: jobId,
          title: jobTitle(summary),
          kind: 'feature',
          overview: summary,
          decisions,
          trackTitles: [],
        });

        void this.requestApprovalAndAct(stimulus, job, decisionRecordId, {
          jobId: job.id,
          decisionRecordId,
          kind: 'direct',
          // The reloaded short title from persistPlan — keeps the card + its live `thread_meta` emit
          // consistent with the durable sidebar title.
          title: job.title ?? jobTitle(summary),
          summary,
          decisions,
          tracks: changeOutline,
        });

        return {
          ok: true,
          jobId: job.id,
          decisionRecordId,
          message:
            'Direct-build approval sent to the operator. On approval I will implement the change ' +
            'directly, then open a PR. You can keep talking; if denied you will be told.',
        };
      },

      finalize_build: async (_args) => {
        // GATED — callable only inside the autonomous implementation turn of an APPROVED direct build
        // (status 'running'). Commits whatever was written, then runs the shared terminal ship.
        const jobId = await this.store.openJobOnThread(stimulus.threadId);
        if (!jobId) return { ok: false, reason: 'No open job on this thread — nothing to finalize' };
        const job = await this.store.loadJob(jobId);
        if (job.status !== 'running') {
          return {
            ok: false,
            reason: `Job ${jobId} is '${job.status}' — only an approved (running) build can be finalized`,
          };
        }
        const sandbox = await this.lifecycle.findSandbox(stimulus.threadId, stimulus.orgId);
        if (!sandbox) return { ok: false, reason: 'No sandbox for this thread — cannot finalize' };

        const rec = (await this.driverStore
          .getDecisionRecord(stimulus.threadId)
          .catch(() => null)) as { overview: string; decisions: Decision[] } | null;
        const repo = await this.repos.resolve(job);

        const result = await this.ship.ship({
          job,
          record: rec,
          repo,
          sandbox,
          commitMessage: `Atlas direct build — ${job.title ?? 'change'}`,
          notify: (m) => this.say(stimulus, m),
        });

        if (!result) {
          return { ok: true, jobId, message: 'Committed, but no GitHub token is configured — PR not opened.' };
        }
        return { ok: true, jobId, prUrl: result.url, prNumber: result.number, message: `PR opened: ${result.url}` };
      },

      create_thread: async (args) => {
        const firstMessage = String(args['firstMessage'] ?? '').trim();
        const title = String(args['title'] ?? '').trim() || jobTitle(firstMessage);
        if (!firstMessage) {
          return { ok: false, reason: 'firstMessage is required (the new thread\'s opening intent)' };
        }

        // Same org + repo as this thread — derived from the closure, never from tool args (no cross-tenant
        // escape). The follow-up inherits this thread's base branch and starts scoping immediately.
        const current = await this.store.loadJob(stimulus.threadId);
        const newThreadId = await this.store.createFollowUpThread({
          orgId: stimulus.orgId,
          repoId: stimulus.repoId,
          title,
          baseBranch: current.baseBranch,
        });

        // Kick the new thread's brain with its opening intent. Fire-and-forget — the parent's turn doesn't
        // block on the child's provisioning (~30s); the intent is recorded so it's visible if the start fails.
        void this.startFollowUpThread(newThreadId, stimulus.orgId, stimulus.repoId, firstMessage).catch((err) =>
          this.logger.warn(`create_thread: start of ${newThreadId} failed: ${err}`),
        );
        this.logger.log(`thread ${stimulus.threadId} created + started follow-up ${newThreadId}`);
        return {
          ok: true,
          threadId: newThreadId,
          message: `Created follow-up "${title}" and started it.`,
        };
      },

      // ── Tickets (the repo's board/backlog) ─────────────────────────────────────────────────────────
      // org/repo/thread context comes from the stimulus CLOSURE, never tool args (no cross-tenant escape).

      create_ticket: async (args) => {
        const title = String(args['title'] ?? '').trim();
        if (!title) return { ok: false, reason: 'title is required' };
        const status = optEnum(args['status'], isTicketStatus) as TicketStatus | undefined;
        if (args['status'] != null && !status) return { ok: false, reason: `invalid status: ${String(args['status'])}` };
        const priority = optEnum(args['priority'], isTicketPriority) as TicketPriority | undefined;
        if (args['priority'] != null && !priority) return { ok: false, reason: `invalid priority: ${String(args['priority'])}` };
        const kind = optEnum(args['kind'], isTicketKind) as TicketKind | undefined;
        if (args['kind'] != null && !kind) return { ok: false, reason: `invalid kind: ${String(args['kind'])}` };

        // Stamp provenance from THIS thread + its locked decision (if any) — closure-derived, not args.
        const job = await this.store.loadJob(stimulus.threadId).catch(() => null);
        try {
          const ticket = await this.tickets.create({
            orgId: stimulus.orgId,
            repoId: stimulus.repoId,
            title,
            body: optStr(args['body']),
            status,
            priority,
            kind,
            originThreadId: stimulus.threadId,
            originDecisionRecordId: job?.decisionRecordId ?? null,
            dependsOn: strArray(args['dependsOn']),
          });
          return { ok: true, ticketId: ticket.id, number: ticket.number, message: `Captured ticket #${ticket.number}: ${title}` };
        } catch (err) {
          return { ok: false, reason: errText(err) };
        }
      },

      list_tickets: async (args) => {
        const status = optEnum(args['status'], isTicketStatus) as TicketStatus | undefined;
        if (args['status'] != null && !status) return { ok: false, reason: `invalid status: ${String(args['status'])}` };
        try {
          const rows = await this.tickets.list({ orgId: stimulus.orgId, repoId: stimulus.repoId, status });
          return {
            ok: true,
            tickets: rows.map((t) => ({ id: t.id, number: t.number, title: t.title, status: t.status, priority: t.priority, kind: t.kind })),
          };
        } catch (err) {
          return { ok: false, reason: errText(err) };
        }
      },

      update_ticket: async (args) => {
        const ticketId = String(args['ticketId'] ?? '').trim();
        if (!ticketId) return { ok: false, reason: 'ticketId is required' };
        const status = optEnum(args['status'], isTicketStatus) as TicketStatus | undefined;
        if (args['status'] != null && !status) return { ok: false, reason: `invalid status: ${String(args['status'])}` };
        const priority = optEnum(args['priority'], isTicketPriority) as TicketPriority | undefined;
        if (args['priority'] != null && !priority) return { ok: false, reason: `invalid priority: ${String(args['priority'])}` };
        const kind = optEnum(args['kind'], isTicketKind) as TicketKind | undefined;
        if (args['kind'] != null && !kind) return { ok: false, reason: `invalid kind: ${String(args['kind'])}` };
        try {
          const t = await this.tickets.update(
            { orgId: stimulus.orgId, repoId: stimulus.repoId, ticketId },
            { title: optStr(args['title']) ?? undefined, body: 'body' in args ? optStr(args['body']) : undefined, status, priority, kind },
          );
          return { ok: true, ticketId: t.id, number: t.number, status: t.status, message: `Updated ticket #${t.number}` };
        } catch (err) {
          return { ok: false, reason: errText(err) };
        }
      },

      link_ticket_dependency: async (args) => {
        const ticketId = String(args['ticketId'] ?? '').trim();
        const dependsOnTicketId = String(args['dependsOnTicketId'] ?? '').trim();
        if (!ticketId || !dependsOnTicketId) return { ok: false, reason: 'ticketId and dependsOnTicketId are required' };
        try {
          await this.tickets.addDependency({ orgId: stimulus.orgId, repoId: stimulus.repoId, ticketId, dependsOnTicketId });
          return { ok: true, message: 'Recorded advisory dependency (blocked-by).' };
        } catch (err) {
          return { ok: false, reason: errText(err) };
        }
      },

      promote_ticket: async (args) => {
        const ticketId = String(args['ticketId'] ?? '').trim();
        if (!ticketId) return { ok: false, reason: 'ticketId is required' };
        try {
          const result = await this.tickets.promote({ orgId: stimulus.orgId, repoId: stimulus.repoId, ticketId });
          if (result.created && result.seedText) {
            // Kick the new thread's brain in-process (same as create_thread). Fire-and-forget.
            void this.startFollowUpThread(result.threadId, stimulus.orgId, stimulus.repoId, result.seedText).catch((err) =>
              this.logger.warn(`promote_ticket: start of ${result.threadId} failed: ${err}`),
            );
          }
          return {
            ok: true,
            threadId: result.threadId,
            created: result.created,
            message: result.created
              ? `Promoted "${result.title}" to a new thread and started it.`
              : `That ticket is already being worked in an existing thread.`,
          };
        } catch (err) {
          return { ok: false, reason: errText(err) };
        }
      },
    };
  }

  /**
   * (Re)generate the thread's `decision-record.md` from its working-set decisions and write it to the
   * READ-ONLY `/context/generated/` bucket (host-side path; the container sees `/context/generated` as a
   * read-only mount). Called on every decision mutation, so the file stays incremental + in lockstep with
   * the structured `pending_decisions` — coding agents read it for grounding but never author it.
   */
  private async writeDecisionRecordMd(
    threadId: string,
    orgId: string,
    decisions: Decision[],
  ): Promise<void> {
    const generatedDir = join(this.lifecycle.contextDirHost(threadId, orgId), 'generated');
    await mkdir(generatedDir, { recursive: true });
    await writeFile(join(generatedDir, 'decision-record.md'), renderDecisionRecordMd(decisions), 'utf8');
  }

  /**
   * Typed-reply fallback for formal questions: if the operator answered an outstanding `ask_question`
   * card in PROSE (the composer) rather than clicking it, stamp that card's durable answered state with
   * the message text so `create_decision` can still auto-attach the Q&A. No-op when there is no pending
   * question or it was already answered (e.g. via the `/answer-question` endpoint, which pre-stamps).
   */
  private async linkTypedQuestionAnswer(stimulus: ChatStimulus): Promise<void> {
    try {
      const pending = await this.store.latestUnansweredQuestionCard(stimulus.threadId);
      if (!pending?.ts) return;
      await this.store.updateCardMessage(stimulus.threadId, pending.ts, {
        answer: stimulus.body,
        answeredAt: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.debug(`linkTypedQuestionAnswer failed for thread=${stimulus.threadId}: ${err}`);
    }
  }

  // ── Approval flow ──────────────────────────────────────────────────────────────────────────────

  /**
   * Post the approval card and act on the verdict — mirrors the old `ConversationalBrainService`
   * flow but without blocking the session turn on it.
   */
  async requestApprovalAndAct(
    stimulus: ChatStimulus,
    job: Thread,
    decisionRecordId: string,
    card: DecisionApprovalCard,
  ): Promise<void> {
    const route = await this.store.route({
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      threadId: stimulus.threadId,
    });
    const channel = route.channel ?? stimulus.replyRoute.threadRef;
    const threadTs = route.threadTs ?? stimulus.replyRoute.threadRef;

    const handle = await this.approvals.request(
      { channel, threadTs, orgId: stimulus.orgId },
      card,
    );

    // §H — the plan reached the operator (a card is now posted). The durable title was already written
    // to `goal` in persistPlan (full path) / jobTitle(summary) (direct); publish a live `thread_meta`
    // frame so the open UI repaints the title in place. Emitted on the CARD path only (never on the
    // pre-review draft return), AFTER the durable write, so live and durable never diverge. Best-effort.
    this.surface.emitThreadMeta?.(stimulus.repoId, stimulus.threadId, card.title);

    let resolution;
    try {
      resolution = await handle.verdict;
    } catch (err) {
      this.logger.warn(`approval wait abandoned for job ${job.id}: ${err}`);
      return;
    }

    if (resolution.verdict === 'approve') {
      const running = await this.store.approve(job.id, decisionRecordId, resolution.ruledBy);
      if (card.kind === 'direct') {
        // FAST PATH: the brain implements it ITSELF in an autonomous in-sandbox turn (no driver).
        await this.store.appendAtlasMessage(
          stimulus.threadId,
          'Approved — implementing the change directly.',
        );
        // Passive milestone (drained into the NEXT operator turn — the synthetic direct-build turn skips
        // the drain). Recorded AFTER the durable `approve`.
        await this.recordMilestone(
          stimulus.threadId,
          `approved:${decisionRecordId}`,
          'Your direct-build plan was approved; I am implementing it directly now.',
        );
        void this.runDirectBuild(stimulus, running);
      } else {
        await this.dispatcher.dispatch(running);
        await this.store.appendAtlasMessage(stimulus.threadId, 'Plan approved — dispatching the build.');
        // Passive milestones — recorded AFTER the durable `approve` + `dispatch`.
        await this.recordMilestone(
          stimulus.threadId,
          `approved:${decisionRecordId}`,
          'Your plan was approved by the operator.',
        );
        await this.recordMilestone(
          stimulus.threadId,
          `dispatched:${decisionRecordId}`,
          'The build pipeline has started running the approved plan.',
        );
      }
      return;
    }

    if (resolution.verdict === 'request_changes') {
      await this.store.reopenScoping(job.id);
      const note = resolution.note ? ` Noted: ${resolution.note}` : '';
      await this.say(
        stimulus,
        `Got it — back to the drawing board.${note} What should change?`,
      );
      return;
    }

    // deny
    await this.store.cancel(job.id);
    await this.say(stimulus, "Understood — I'll drop this one.");
  }

  // ── Direct-build (fast path) ─────────────────────────────────────────────────────────────────────

  /**
   * Run the AUTONOMOUS implementation turn for an approved direct build. The brain wrote the change's
   * spec to `/context` during the sitting; now (post-approval, no operator present) it implements it
   * ITSELF in the worktree and calls `finalize_build` to ship. Reuses the normal in-sandbox turn path
   * via a synthetic, Atlas-authored stimulus (the same pattern `startFollowUpThread` uses) so the work
   * streams to the thread and the session keeps full context. Fire-and-forget — errors are surfaced by
   * the turn itself.
   */
  private async runDirectBuild(stimulus: ChatStimulus, job: Thread): Promise<void> {
    const instruction =
      'The direct-build plan was APPROVED. Implement the change now, directly, in the repo ' +
      '(`/workspace`) — follow the spec/notes you wrote under `/context`. When the change is complete ' +
      'and you have verified it, call `finalize_build` to commit, review, and open the PR. Do NOT call ' +
      'submit_plan or start_direct_build again.';
    const synthetic: ChatStimulus = {
      ...stimulus,
      id: randomUUID(),
      body: instruction,
      receivedAt: new Date(),
      author: { id: 'atlas', displayName: 'Atlas' },
    };
    try {
      await this.handleChatTurn(synthetic);
    } catch (err) {
      this.logger.error(`direct build implementation turn failed for thread=${job.id}: ${err}`);
      await this.say(stimulus, `The direct build hit an error — ${String(err).slice(0, 200)}`);
    }
  }

  // ── create_thread: start the follow-up's brain ──────────────────────────────────────────────────

  /**
   * Kick a freshly-created follow-up thread's brain with its opening intent. Records the intent into the
   * transcript first (the brain path doesn't persist the inbound message — intake normally does), then runs
   * one chat turn (which lazily provisions the new thread's sandbox).
   */
  async startFollowUpThread(
    threadId: string,
    orgId: string,
    repoId: string,
    firstMessage: string,
  ): Promise<void> {
    await this.store.appendAtlasMessage(threadId, `🔗 Follow-up started from a prior thread:\n\n${firstMessage}`);
    const stimulus: ChatStimulus = {
      id: randomUUID(), // synthetic — the brain path doesn't persist the stimulus row
      orgId,
      repoId,
      body: firstMessage,
      receivedAt: new Date(),
      kind: 'chat',
      trust: 'trusted',
      threadId,
      author: { id: 'atlas', displayName: 'Atlas' },
      replyRoute: { surfaceId: 'web', threadRef: threadId },
    };
    await this.handleChatTurn(stimulus);
  }

  // ── Async Codex plan review: run + deliver findings ──────────────────────────────────────────────

  /**
   * Run a review round's Codex turn (in the sandbox, 5-30 min) then deliver its findings to Atlas. Kicked
   * fire-and-forget from `submit_plan` and from boot reconciliation. `runReview` records the terminal
   * status durably; `deliverReviewFindings` no-ops until the row is terminal, so an unexpected throw here
   * simply leaves the row for the boot sweep.
   */
  private async runAndDeliverReview(reviewId: string): Promise<void> {
    try {
      await this.planReview.runReview(reviewId);
    } catch (err) {
      this.logger.warn(`plan-review run failed for review=${reviewId}: ${err}`);
    }
    await this.deliverReviewFindings(reviewId).catch((err) =>
      this.logger.warn(`plan-review delivery failed for review=${reviewId}: ${err}`),
    );
  }

  /**
   * Deliver a COMPLETED review's findings to Atlas: (1) persist the operator-visible, harness-sourced
   * "Codex review" message IDEMPOTENTLY (deterministic `ts` keyed by the review id — so a boot re-delivery
   * can't duplicate the visible findings), then (2) hand the same text to the brain in a server-initiated
   * HARNESS turn (serialized behind any in-flight turn by the turn queue). `delivered_at` is stamped ONLY
   * after that turn completes — a crash before then re-delivers next boot (at-least-once). No-op if the
   * review isn't terminal yet (boot will re-run it) or was already delivered.
   */
  private async deliverReviewFindings(reviewId: string): Promise<void> {
    const review = await this.planReview.load(reviewId);
    if (!review) return;
    if (review.delivered_at) return; // already delivered
    if (review.status === 'running') return; // not finished — boot reconciliation will re-run it
    const job = await this.store.loadJob(review.thread_id).catch(() => null);
    if (!job) return;

    const capReached = review.round >= this.planReview.maxReviewRounds;
    const status = review.status === 'failed' ? 'failed' : 'complete';
    const body = renderFindingsDelivery(review.findings ?? '', review.round, capReached, status, review.error);

    // (1) The single operator-visible artifact (idempotent on the review id).
    await this.store.appendReviewFindingsMessage(review.thread_id, review.id, body);

    // (2) Deliver to the brain via a synthetic harness turn (skips the operator-only paths).
    const stimulus = harnessDeliveryStimulus({
      threadId: review.thread_id,
      orgId: review.org_id,
      repoId: job.repoId,
      body,
    });
    await this.handleChatTurn(stimulus);

    // (3) Reached only when the delivery turn completed — stamp delivered so boot won't re-deliver.
    await this.planReview.markDelivered(review.id);
  }

  /**
   * Resolve the originating ticket for a thread's plan review (the operator's captured intent) — null
   * when the thread isn't tied to a ticket. Best-effort: any lookup failure → null (the review still
   * runs on the goal + overview).
   */
  private async resolveReviewTicket(
    orgId: string,
    repoId: string,
    threadId: string,
  ): Promise<{ number: number; title: string; body?: string } | null> {
    try {
      const ticketId = await this.store.threadTicketId(threadId);
      if (!ticketId) return null;
      const { ticket } = await this.tickets.get({ orgId, repoId, ticketId });
      return { number: ticket.number, title: ticket.title, ...(ticket.body ? { body: ticket.body } : {}) };
    } catch (err) {
      this.logger.debug(`resolveReviewTicket failed (continuing without ticket): ${err}`);
      return null;
    }
  }

  // ── Passive pipeline-milestone awareness ─────────────────────────────────────────────────────────

  /**
   * Drain the thread's buffered milestones + the net-current-state delta and render the clearly-passive
   * prefix to prepend to this OPERATOR turn (null when there's nothing to convey). Atomic drain (a single
   * locked transaction in the store) so a milestone the driver appends mid-turn isn't read-cleared and
   * lost. Best-effort: any failure returns null so the turn proceeds — `get_pipeline_state` remains the
   * authoritative pull.
   */
  private async buildAwarenessPrefix(threadId: string, orgId: string): Promise<string | null> {
    try {
      const state = await this.driverStore.getPipelineState(threadId, orgId);
      const sig = pipelineStateSignature(state);
      const { markers, stateChanged } = await this.awareness.drainAndAdvance(threadId, sig);
      if (markers.length === 0 && !stateChanged) return null;
      const prefix = renderAwarenessPrefix(
        markers,
        stateChanged ? renderPipelineStateSummary(state) : null,
      );
      return prefix || null;
    } catch (err) {
      this.logger.debug(`pipeline-awareness prefix failed (continuing): ${err}`);
      return null;
    }
  }

  /** Buffer a passive pipeline milestone for the brain (no turn runs). Best-effort + idempotent by `id`. */
  private async recordMilestone(threadId: string, id: string, text: string): Promise<void> {
    await this.awareness
      .appendMarker(threadId, { id, text, at: new Date().toISOString() })
      .catch((err) => this.logger.debug(`milestone append failed (continuing): ${err}`));
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────────────────────

  /** Post a reply in-thread AND append it to the durable transcript. */
  private async say(stimulus: ChatStimulus, text: string): Promise<void> {
    const route = await this.store.route({
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      threadId: stimulus.threadId,
    });
    const channel = route.channel ?? stimulus.replyRoute.threadRef;
    const threadTs = route.threadTs ?? stimulus.replyRoute.threadRef;
    try {
      await this.surface.post(channel, text, { threadTs, orgId: stimulus.orgId });
    } catch (err) {
      this.logger.warn(`failed to post brain reply: ${err}`);
    }
    await this.store.appendAtlasMessage(stimulus.threadId, text);
  }

  /**
   * Post a SYSTEM→OPERATOR notice — a runtime/harness message for the OPERATOR ONLY, NOT in Atlas's voice
   * and never seeded into the brain (e.g. an unresumable-thread error). Mirrors {@link say} (live SSE post
   * + durable row) but stamps `meta.source='system_operator'` so the web renders its own system-notice box.
   */
  private async saySystemOperator(stimulus: ChatStimulus, text: string): Promise<void> {
    const route = await this.store.route({
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      threadId: stimulus.threadId,
    });
    const channel = route.channel ?? stimulus.replyRoute.threadRef;
    const threadTs = route.threadTs ?? stimulus.replyRoute.threadRef;
    try {
      await this.surface.post(channel, text, {
        threadTs,
        orgId: stimulus.orgId,
        meta: { source: 'system_operator' },
      });
    } catch (err) {
      this.logger.warn(`failed to post system→operator notice: ${err}`);
    }
    await this.store.appendSystemOperatorMessage(stimulus.threadId, text);
  }

  /** Find the open scoping job on this thread, or open a fresh one. */
  private async ensureJob(
    stimulus: ChatStimulus,
    title: string,
    kind: ThreadKind,
  ): Promise<string> {
    const existing = await this.store.openJobOnThread(stimulus.threadId);
    if (existing) return existing;
    return this.store.openJob({
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      threadId: stimulus.threadId,
      title: jobTitle(title),
      kind,
    });
  }
}

/** The synthetic author id Atlas stamps on its own (non-operator) turns — runDirectBuild /
 *  startFollowUpThread. The passive-awareness flush is gated on this so a background turn never drains
 *  the buffer before the operator sees it. */
const ATLAS_AUTHOR_ID = 'atlas';

/** True when a turn was authored by the operator — NOT a synthetic Atlas turn and NOT a host-originated
 *  system seed. Both background kinds must skip the passive-awareness drain so a real operator turn still
 *  gets the buffered milestones. */
function isOperatorAuthored(stimulus: ChatStimulus): boolean {
  return stimulus.author.id !== ATLAS_AUTHOR_ID && stimulus.author.id !== SYSTEM_SEED_AUTHOR.id;
}

/**
 * Build the synthetic SYSTEM-SEED stimulus that delivers a completed Codex review's findings to the brain
 * straight through `handleChatTurn`. Reuses the canonical host-seed convention (SYSTEM_SEED_AUTHOR + `seed`
 * + `<system_notification>` envelope, same as the `/answer-question` delivery) so it skips the operator-only
 * paths (passive-awareness drain + typed-answer linkage). The wrapped body is what the brain reads; the
 * operator sees the same findings as the durable, idempotent "Codex review" message.
 */
function harnessDeliveryStimulus(input: {
  threadId: string;
  orgId: string;
  repoId: string;
  body: string;
}): ChatStimulus {
  return {
    id: randomUUID(), // synthetic — the brain path doesn't persist the stimulus row
    orgId: input.orgId,
    repoId: input.repoId,
    body: wrapSystemNotification(input.body),
    receivedAt: new Date(),
    kind: 'chat',
    trust: 'trusted',
    threadId: input.threadId,
    author: { id: SYSTEM_SEED_AUTHOR.id, displayName: SYSTEM_SEED_AUTHOR.name },
    replyRoute: { surfaceId: 'web', threadRef: input.threadId },
    seed: true,
  };
}

/** Frame a delivered answer as a SYSTEM SEED (matches the live `/answer-question` path), not a chat line. */
function frameAnswer(question: string, answer: string): string {
  return wrapSystemNotification(
    `The operator answered your question ${JSON.stringify(question)}: ${answer}`,
  );
}

/**
 * Build the synthetic OPERATOR stimulus the boot sweep uses to re-deliver an answered-but-undelivered
 * question straight through `handleChatTurn` (bypassing the surface). Operator-authored (so it is treated
 * as the operator's reply and passive awareness still drains); the framed body restates the Q&A since
 * there is no natural inbound message to carry it.
 */
function bootDeliveryStimulus(q: {
  threadId: string;
  orgId: string;
  repoId: string;
  question: string;
  answer: string;
}): ChatStimulus {
  return {
    id: randomUUID(),
    orgId: q.orgId,
    repoId: q.repoId,
    body: frameAnswer(q.question, q.answer),
    receivedAt: new Date(),
    kind: 'chat',
    trust: 'trusted',
    threadId: q.threadId,
    author: { id: SYSTEM_SEED_AUTHOR.id, displayName: SYSTEM_SEED_AUTHOR.name },
    replyRoute: { surfaceId: 'web', threadRef: q.threadId },
    seed: true,
  };
}

/** Normalize a raw `decisions` tool arg into typed locked decisions (drops malformed entries). */
function normalizeDecisions(raw: unknown): Decision[] {
  const arr = Array.isArray(raw) ? raw : [];
  const candidates = arr.filter(
    (d): d is Record<string, unknown> =>
      typeof d === 'object' && d !== null && 'decisionClass' in d && 'title' in d && 'ruling' in d,
  );
  // Preserve id/question/answer (this override path otherwise regresses the "fully resolved decision"
  // contract); assign a fresh stable id to any entry missing one, unique across the produced set.
  const out: Decision[] = [];
  for (const d of candidates) {
    const id = typeof d['id'] === 'string' && d['id'] ? (d['id'] as string) : nextDecisionId(out);
    out.push({
      id,
      decisionClass: d['decisionClass'] as Decision['decisionClass'],
      title: String(d['title']),
      ruling: String(d['ruling']),
      ...(typeof d['question'] === 'string' ? { question: d['question'] } : {}),
      ...(typeof d['answer'] === 'string' ? { answer: d['answer'] } : {}),
      // Carry provenance through the override path; absent → undefined (renders as Atlas-authored).
      ...(d['confirmedByOperator'] === true ? { confirmedByOperator: true } : {}),
    });
  }
  return out;
}

/** A short job title from a summary line. */
function jobTitle(summary: string): string {
  const firstLine = summary.split('\n').map((l) => l.trim()).find(Boolean) ?? summary;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

// ── Question / decision tool arg coercion ──────────────────────────────────────────────────────────

// Derived from the SSOT (DECISION_CLASS_META → DECISION_CLASS_IDS) — do NOT re-list the classes here.
const DECISION_CLASSES: ReadonlySet<string> = new Set<string>(DECISION_CLASS_IDS);

/**
 * Coerce a raw `decisionClass` arg into a valid {@link DecisionClass}, or undefined. Tolerant: the SDK
 * exposes a generic tool schema (no enum), so the model often guesses the token format — it sent
 * `api-contract`/`data-model` (hyphens) before self-correcting. Normalize casing + hyphens/spaces to the
 * canonical underscore id so a natural guess just works instead of costing a rejected round-trip.
 */
function asDecisionClass(v: unknown): DecisionClass | undefined {
  if (typeof v !== 'string') return undefined;
  const norm = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return DECISION_CLASSES.has(norm) ? (norm as DecisionClass) : undefined;
}

/**
 * The bridge wraps every tool's parameters under a single `args` object (the SDK schema strips
 * unrecognized top-level keys). When the model forgets the wrapper, the host receives `{}` and a
 * field-specific error ("decisionClass must be one of…") MISLEADS it into fixing the wrong thing.
 * Detect the empty-args case up front and return a hint that points at the real cause: the envelope.
 */
function missingArgsEnvelope(args: Record<string, unknown>): { ok: false; reason: string } | null {
  if (args && Object.keys(args).length > 0) return null;
  return {
    ok: false,
    reason:
      'No arguments received — pass ALL parameters inside a single `args` object ' +
      '(e.g. { args: { decisionClass, ruling, title } }), not at the top level.',
  };
}

/**
 * Normalize the `ask_question` `options` arg into `{ id?, label, description? }[]`. Accepts plain strings
 * ("Yes") or objects ({ label, description }); drops empties. The card builder fills missing ids.
 */
function normalizeQuestionOptions(raw: unknown): { id?: string; label: string; description?: string }[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: { id?: string; label: string; description?: string }[] = [];
  for (const o of arr) {
    if (typeof o === 'string') {
      const label = o.trim();
      if (label) out.push({ label });
    } else if (o && typeof o === 'object' && 'label' in o) {
      const label = String((o as { label: unknown }).label ?? '').trim();
      if (!label) continue;
      const id = optStr((o as { id?: unknown }).id);
      const description = optStr((o as { description?: unknown }).description);
      out.push({ label, ...(id ? { id } : {}), ...(description ? { description } : {}) });
    }
  }
  return out;
}

/** Derive a short decision title from the question (or ruling) when the brain doesn't supply one. */
function deriveDecisionTitle(source: string): string {
  const firstLine = source.split('\n').map((l) => l.trim()).find(Boolean) ?? source;
  const cleaned = firstLine.replace(/[?:.]+$/, '').trim();
  return cleaned.length > 72 ? `${cleaned.slice(0, 69)}...` : cleaned || 'Decision';
}

// ── Ticket-tool arg coercion (args are Record<string, unknown> from the bridge) ────────────────────

/** A trimmed non-empty string, or undefined. */
function optStr(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : undefined;
}

/** Return the value only if it passes the allow-list guard; else undefined (caller decides if that's an error). */
function optEnum<T>(v: unknown, guard: (x: unknown) => x is T): T | undefined {
  return guard(v) ? v : undefined;
}

/** Coerce an arg into an array of non-empty strings (the bridge may pass a single string or an array). */
function strArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
    return out.length > 0 ? out : undefined;
  }
  const single = optStr(v);
  return single ? [single] : undefined;
}

/** A safe, short error message for a tool's `{ ok:false, reason }` (surfaces validation/404 cleanly). */
function errText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message).slice(0, 200);
  return String(err).slice(0, 200);
}

/**
 * Normalize the `submit_plan` `tracks` arg into ordered tracks, each with the ordered step list
 * Atlas authored up front: `{ title, steps: [{ title, brief }] }`. `brief` = the keystroke-level
 * execute instructions for that step (what the build worker runs). Phases missing a title OR a brief
 * are dropped; a track with an empty/whitespace title is dropped. The caller enforces ≥1 step/track.
 */
function normalizeTracks(raw: unknown): { title: string; type: string; steps: PlannedStep[] }[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: { title: string; type: string; steps: PlannedStep[] }[] = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const o = s as { title?: unknown; brief?: unknown; type?: unknown; steps?: unknown };
    const title = String(o.title ?? o.brief ?? '').trim();
    if (!title) continue;
    // Scope type selects the review agents (TRACK_TYPES), but allow-other — a non-enum value is stored
    // verbatim (lowercased); default 'general' when absent (the prompt asks the brain to set one).
    const type = String(o.type ?? '').trim().toLowerCase() || 'general';
    const stepsRaw = Array.isArray(o.steps) ? o.steps : [];
    const steps: PlannedStep[] = [];
    for (const p of stepsRaw) {
      if (!p || typeof p !== 'object') continue;
      const po = p as { title?: unknown; brief?: unknown };
      const pTitle = String(po.title ?? '').trim();
      const pBrief = String(po.brief ?? '').trim();
      if (pTitle && pBrief) steps.push({ title: pTitle, brief: pBrief });
    }
    out.push({ title, type, steps });
  }
  return out;
}
