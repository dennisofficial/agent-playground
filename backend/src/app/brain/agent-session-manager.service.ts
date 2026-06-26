import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ChatStimulus, Thread, ThreadKind } from '../domain';
import { MemoryStore } from '../memory';
import { CHAT_SURFACE, type ChatSurface, type DecisionApprovalCard, LiveTurnStore } from '../surface';
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
import { DecisionClassifier } from '../decision-gate';
import { CredentialResolver } from '../onboarding';
import { TicketService } from '../tickets';
import type { TicketKind, TicketPriority, TicketStatus } from '../domain/ticket';
import { isTicketKind, isTicketPriority, isTicketStatus } from '../domain/ticket';
import type { Decision } from '../domain';
import { DockerEngineRunner } from '../sandbox/docker-engine-runner';
import { BRIDGE_SERVER_NAME } from '../sandbox/image/bridge-options';
import { SANDBOX_RESET_NOTICE } from '../engine/engine.types';
import type { EngineRunnerPort, ToolImpl, RunEngineArgs, EngineEvent } from '../engine/engine.types';
import { BrainStoreService } from './brain-store.service';
import { DecisionApprovalService } from './decision-approval.service';
import { JOB_DISPATCHER, type JobDispatcher } from './job-dispatcher';
import { PlanReviewService, buildRevisionInstruction } from './plan-review.service';

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
 *   - `submit_plan` → `BrainStoreService.persistPlan` → approval card via `DecisionApprovalService`.
 *   - On approve → `JOB_DISPATCHER.dispatch`; on deny/request_changes → keep talking.
 *   - session_id is persisted on the `thread_sandboxes` row so it survives host restarts.
 */
@Injectable()
export class AgentSessionManager {
  private readonly logger = new Logger(AgentSessionManager.name);

  /**
   * The thread brain's model — the conversational/planning session that grills, locks decisions, and
   * proposes plans. Pinned to Opus (the SDK accepts the `'opus'` alias → latest Opus). A code constant,
   * NOT an env var — model choice doesn't vary by environment. (Phase workers default to Opus too, in
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
  ) {}

  // ── System prompt for the custom plan mode ──────────────────────────────────────────────────────

  private static readonly SYSTEM_PROMPT = [
    'You are Atlas, an autonomous software-engineering orchestrator. You are talking with the operator',
    'to shape ONE feature or bug fix, lock the decisions, get ONE approval — then build it autonomously.',
    '',
    `You have 14 host tools, all served by the "${BRIDGE_SERVER_NAME}" MCP server. The SDK exposes each one`,
    `under its fully-qualified name "mcp__${BRIDGE_SERVER_NAME}__<tool>" — that is the ONLY name that works.`,
    `ALWAYS call the qualified name (e.g. mcp__${BRIDGE_SERVER_NAME}__submit_plan); the bare name`,
    '(e.g. submit_plan) is NOT a registered tool and will fail with "No such tool available". The prose',
    `below abbreviates these to short names for readability, but you must call the mcp__${BRIDGE_SERVER_NAME}__`,
    'form. The 14 tools:',
    `  - mcp__${BRIDGE_SERVER_NAME}__get_pipeline_state   — read the current job/pipeline state for this thread`,
    `  - mcp__${BRIDGE_SERVER_NAME}__get_decision_record  — read the current locked decision record for this thread`,
    `  - mcp__${BRIDGE_SERVER_NAME}__recall               — retrieve relevant memory facts (semantic search)`,
    `  - mcp__${BRIDGE_SERVER_NAME}__remember             — store a new memory fact`,
    `  - mcp__${BRIDGE_SERVER_NAME}__submit_plan          — propose the full multi-section plan for approval (FULL PATH; see below)`,
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
    '',
    'GRILLING PROTOCOL (applies to BOTH paths): lock the always-ask decisions before proposing — data',
    'model/schema, public API contracts, new dependencies, infrastructure/topology, cross-cutting patterns',
    '(auth, caching, state, concurrency, error-handling), one-way doors. For security/auth: surface EACH',
    'mechanism as its OWN decision. Ask ONE focused question at a time. Do NOT ask about never-ask details',
    '(naming, file placement, test layout).',
    '',
    'THE /context SHARED FOLDER: `/context` is a durable, per-thread space OUTSIDE the repo, shared with the',
    'build sessions. Two buckets:',
    '  • `/context/specs/` — THE PLAN, authored LIVE as you work (NOT in one burst at the end). The operator',
    '    watches this folder fill in as the conversation progresses, so keep it current:',
    '      – The MOMENT you lock an always-ask decision, append it to `/context/specs/decision-record.md`',
    '        (the decision, the ruling, and why) — do this BEFORE moving to your next question, every time.',
    '      – As the shape of the work firms up, grow `/context/specs/plan.md` (the full plan) and any',
    '        diagrams/mermaid alongside it, revising as decisions change things.',
    '    This folder IS the plan and the source of truth; the build phases read it for grounding.',
    '  • `/context/artifacts/` — OUTPUTS for the human: preview HTML, screenshots, reports (never the repo).',
    'Treat the repo (`/workspace`) as READ-ONLY until a build is approved — never modify it while planning;',
    'write to `/context` instead.',
    '',
    'TWO PATHS — choose based on size/risk:',
    '',
    'FULL PATH — submit_plan (multi-section build run by the deterministic driver). Use for anything beyond',
    'a small, localized change. By the time you reach this point you have ALREADY authored the plan live in',
    '`/context/specs/` (per THE /context SHARED FOLDER above): `plan.md` structured by section — each section',
    'covering goal, touch points (exact files/symbols you actually read), changes per site, constraints',
    'honored, edge cases, verification, risks — plus the running `decision-record.md` and any diagrams.',
    '`submit_plan` does NOT author the plan; it simply FLIPS the thread to approval-awaiting and posts the',
    'approval card from the section titles. Ensure `/context/specs/` is complete and current FIRST, then call',
    'submit_plan with:',
    '  - overview: intent + stack + constraints',
    '  - decisions: locked decisions, each { decisionClass, title, ruling }',
    '    (decisionClass: data_model | api_contract | dependency | infrastructure | cross_cutting | one_way_door)',
    '  - sections: the ordered section TITLES (e.g. ["Toggle", "Tokens", "Docs"]) — just the labels; the',
    '    detail lives in `/context/specs/plan.md`, which the build reads. Do NOT attach files here.',
    'SECTION GRANULARITY: a section is a BROAD, COHERENT MILESTONE (a slice you could demo or review on its',
    'own), NOT a single technical component. The fine steps — the data model, a migration, one service, the',
    'wiring — are PHASES the build planner derives JIT INSIDE a section; do NOT list them as sections. Prefer',
    'FEW, BROAD sections (≈1–4 for a typical feature). Do NOT split purely by technical layer',
    '(model / service / worker / API / UI) — that produces narrow, tightly-coupled sections; group related',
    'work into a milestone instead (e.g. "Scheduling engine (backend)" with the model+service+worker as its',
    'phases, "Schedules panel" with the API+UI as its phases). Splitting by layer is right ONLY when a layer',
    'is genuinely large on its own. Broad sections do not bloat context — each phase is a fresh engine turn.',
    'SELF-CHECK before submit_plan: every applicable always-ask decision locked? could a fresh engineer build',
    'from `plan.md` with ZERO further questions to you? is it grounded in files you actually opened? is each',
    'section a coherent milestone (not a lone component)? Do NOT add an "investigate the codebase" section —',
    'sections are real build work.',
    '',
    'FAST PATH — start_direct_build (a small, localized change you implement YOURSELF, no sections/phases).',
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
  ].join('\n');

  // ── Public API ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Handle one chat stimulus in a scoping thread. SERIALIZED per thread: if a turn is already running for
   * this thread (the operator sent a follow-up while it was thinking), this one queues behind it and runs
   * after — never two concurrent engine turns resuming the same session id. Runs an in-sandbox engine
   * turn with the 6 host-side tools; the session is resumed across turns.
   */
  async handleChatTurn(stimulus: ChatStimulus): Promise<void> {
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

  /** One chat turn (provision → attach → in-sandbox engine turn → stream + persist). Serialized by the
   *  `handleChatTurn` queue above — never invoked concurrently for the same thread. */
  private async runChatTurn(stimulus: ChatStimulus): Promise<void> {
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
      await this.say(stimulus, `I ran into an error — please try again. (${String(err).slice(0, 200)})`);
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
            if (e.text.trim()) blocks.push({ kind: 'chat', text: e.text, emittedAt: stamp() });
            break;
          case 'thinking':
            if (e.text.trim()) blocks.push({ kind: 'thinking', text: e.text, emittedAt: stamp() });
            break;
          case 'tool_use':
            blocks.push({
              kind: 'tool',
              toolId: e.id || `tool-${blocks.length}`,
              done: false,
              meta: { name: e.name, input: e.input ?? null, result: null, isError: false },
              emittedAt: stamp(),
            });
            break;
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
    return {
      get_pipeline_state: async (_args) => {
        return this.driverStore.getPipelineState(stimulus.threadId, stimulus.orgId);
      },

      get_decision_record: async (_args) => {
        return this.driverStore.getDecisionRecord(stimulus.threadId);
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

      submit_plan: async (args) => {
        const overview = String(args['overview'] ?? '').trim();
        const decisions = normalizeDecisions(args['decisions']);
        // The full plan (plan.md, decisions, diagrams) lives in the thread's `/context/specs` folder —
        // `submit_plan` carries only the ordered section TITLES (the pipeline §1/§2/§3); no files attached.
        const sectionBriefs = normalizeSectionTitles(args['sections']);

        if (!overview || sectionBriefs.length === 0) {
          return { ok: false, reason: 'overview and at least one section title are required' };
        }

        // Ensure there's an open scoping job on this thread.
        const jobId = await this.ensureJob(stimulus, overview, 'feature');

        const { thread: job, decisionRecordId } = await this.store.persistPlan({
          orgId: stimulus.orgId,
          repoId: stimulus.repoId,
          threadId: jobId,
          title: jobTitle(overview),
          kind: 'feature',
          overview,
          decisions,
          sectionBriefs,
        });

        // ── R4: Codex plan pre-review (one-shot) ──────────────────────────────────────────────
        // First call: run a Codex review turn in the thread's sandbox → return findings to the
        // session for ONE revision.  Second call (same job): skip review → straight to approval.
        const sandbox = await this.lifecycle.findSandbox(stimulus.threadId, stimulus.orgId);
        if (sandbox) {
          const reviewResult = await this.planReview.review({
            jobId: job.id,
            orgId: stimulus.orgId,
            worktreePath: sandbox.worktreePath,
            ...(sandbox.containerId ? { containerId: sandbox.containerId } : {}),
            overview,
            decisions,
            sectionBriefs,
          });

          if (reviewResult !== null) {
            // FIRST call: review ran.
            if (reviewResult.findings) {
              // Findings found — relay them back into the session for one revision.
              // The session will call submit_plan again with an updated plan.
              return {
                ok: true,
                jobId: job.id,
                decisionRecordId,
                pendingReview: true,
                message:
                  'Plan persisted and reviewed by Codex before sending to the operator. ' +
                  buildRevisionInstruction(reviewResult.findings),
              };
            }
            // No findings — fall through to the approval card immediately (clean plan).
            this.logger.log(`plan-review: job=${job.id} clean — proceeding to approval card`);
          }
          // reviewResult === null → second call (one-pass guard fired) → fall through to approval.
        }
        // ── End R4 ─────────────────────────────────────────────────────────────────────────────

        // Request approval — fire the approval card and await the verdict in the background.
        // The tool response returns immediately; the approval flow is async.
        void this.requestApprovalAndAct(stimulus, job, decisionRecordId, {
          jobId: job.id,
          decisionRecordId,
          title: jobTitle(overview),
          summary: overview,
          decisions,
          sections: sectionBriefs,
        });

        return {
          ok: true,
          jobId: job.id,
          decisionRecordId,
          message:
            'Plan submitted — the approval card has been sent to the operator. ' +
            'The build will start automatically if approved. ' +
            'You can continue the conversation; if denied you will be told.',
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
        // FAST PATH — a small, localized change the brain implements ITSELF (no sections/phases). Still
        // gated by a lightweight approval; on approval an autonomous implementation turn runs.
        const summary = String(args['summary'] ?? '').trim();
        if (!summary) {
          return { ok: false, reason: 'summary is required (what you will change, directly)' };
        }
        const changeOutline = Array.isArray(args['changeOutline'])
          ? args['changeOutline'].map((c) => String(c).trim()).filter(Boolean)
          : [];
        const decisions = normalizeDecisions(args['decisions']);

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

        // Persist a MINIMAL record (overview = summary, any locked decisions, NO sections) and post the
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
          sectionBriefs: [],
        });

        void this.requestApprovalAndAct(stimulus, job, decisionRecordId, {
          jobId: job.id,
          decisionRecordId,
          kind: 'direct',
          title: jobTitle(summary),
          summary,
          decisions,
          sections: changeOutline,
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

/** True when a turn was authored by the operator (not a synthetic Atlas-authored turn). */
function isOperatorAuthored(stimulus: ChatStimulus): boolean {
  return stimulus.author.id !== ATLAS_AUTHOR_ID;
}

/** Normalize a raw `decisions` tool arg into typed locked decisions (drops malformed entries). */
function normalizeDecisions(raw: unknown): Decision[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .filter(
      (d): d is { decisionClass: string; title: string; ruling: string } =>
        typeof d === 'object' && d !== null && 'decisionClass' in d && 'title' in d && 'ruling' in d,
    )
    .map((d) => ({
      decisionClass: d.decisionClass as Decision['decisionClass'],
      title: d.title,
      ruling: d.ruling,
    }));
}

/** A short job title from a summary line. */
function jobTitle(summary: string): string {
  const firstLine = summary.split('\n').map((l) => l.trim()).find(Boolean) ?? summary;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
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
 * Normalize the `submit_plan` `sections` arg into ordered section TITLES (the pipeline §1/§2/§3). Accepts
 * plain strings or `{ title }` objects; the full plan detail lives in `/context/specs`, not here.
 */
function normalizeSectionTitles(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map((s) => {
      if (typeof s === 'string') return s.trim();
      if (typeof s === 'object' && s !== null) {
        const o = s as { title?: string; brief?: string };
        return (o.title ?? o.brief ?? '').trim();
      }
      return '';
    })
    .filter(Boolean);
}
