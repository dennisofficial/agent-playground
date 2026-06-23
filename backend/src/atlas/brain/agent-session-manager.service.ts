import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ChatStimulus, Job } from '../domain';
import { AtlasMemoryStore } from '../memory';
import { CHAT_SURFACE, type ChatSurface, type DecisionApprovalCard } from '../surface';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasThreadSandbox } from '../persistence/entities';
import { ThreadLifecycleService } from '../driver/thread-lifecycle.service';
import { DriverStoreService } from '../driver/driver-store.service';
import { DockerEngineRunner } from '../sandbox/docker-engine-runner';
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
 *   - session_id is persisted on the `atlas_thread_sandboxes` row so it survives host restarts.
 */
@Injectable()
export class AgentSessionManager {
  private readonly logger = new Logger(AgentSessionManager.name);

  constructor(
    private readonly store: BrainStoreService,
    private readonly driverStore: DriverStoreService,
    private readonly memory: AtlasMemoryStore,
    private readonly approvals: DecisionApprovalService,
    private readonly lifecycle: ThreadLifecycleService,
    private readonly dockerRunner: DockerEngineRunner,
    private readonly planReview: PlanReviewService,
    @Inject(JOB_DISPATCHER) private readonly dispatcher: JobDispatcher,
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
    @InjectRepository(AtlasThreadSandbox, ATLAS_CONNECTION)
    private readonly sandboxRows: Repository<AtlasThreadSandbox>,
  ) {}

  // ── System prompt for the custom plan mode ──────────────────────────────────────────────────────

  private static readonly SYSTEM_PROMPT = [
    'You are Atlas, an autonomous software-engineering orchestrator. You are talking with the operator',
    'to shape ONE feature or bug fix into a DETAILED, LOCKED PLAN.',
    '',
    'You have 6 tools:',
    '  - get_pipeline_state   — read the current job/pipeline state for this thread',
    '  - get_decision_record  — read the current locked decision record for this thread',
    '  - recall               — retrieve relevant memory facts (semantic search)',
    '  - remember             — store a new memory fact',
    '  - submit_plan          — propose the detailed locked plan for operator approval (see below)',
    '  - dispatch_build       — (gated: only usable AFTER operator approval) dispatch the approved build',
    '',
    'PLANNING POSTURE — CUSTOM PLAN MODE:',
    'Do NOT use the SDK\'s native ExitPlanMode. Instead, call `submit_plan` when you have a complete plan.',
    'Before proposing, INVESTIGATE THE REPO: use your Read/Glob/Grep tools to ground the plan in the',
    'actual codebase (stack, structure, conventions). Never ask the operator anything the repo already',
    'answers (tech stack, file existence, tooling, how the codebase does something).',
    '',
    'GRILLING PROTOCOL:',
    'Lock the always-ask decisions before proposing: data model/schema, public API contracts, new',
    'dependencies, infrastructure/topology, cross-cutting patterns (auth, caching, state, concurrency,',
    'error-handling), one-way doors. For security/auth: surface EACH mechanism as its OWN decision.',
    'Ask ONE focused question at a time. Do NOT ask about never-ask details (naming, file placement,',
    'test layout).',
    '',
    'SUBMIT_PLAN — call this when the applicable always-ask decisions are settled:',
    '  - overview: concise intent + stack + constraints',
    '  - decisions: array of locked decisions, each { decisionClass, title, ruling }',
    '    (decisionClass: data_model | api_contract | dependency | infrastructure | cross_cutting | one_way_door)',
    '  - sections: ordered array of DETAILED section specs (not just one-liners — each section has enough',
    '    context for the build phase to execute without re-asking you; include the files/patterns to follow)',
    '',
    'The repo is checked out in your current working directory — investigate it freely (read-only until',
    'the plan is approved). Do not propose a plan with an "investigate the codebase" section — sections',
    'are real build work, not scoping work.',
  ].join('\n');

  // ── Public API ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Handle one chat stimulus in a scoping thread. Runs an in-sandbox engine turn with the 6 host-side
   * tools. Session is resumed if a session_id is persisted for this thread.
   */
  async handleChatTurn(stimulus: ChatStimulus): Promise<void> {
    const sandbox = await this.lifecycle.findSandbox(stimulus.threadId, stimulus.teamId);
    if (!sandbox) {
      // No sandbox provisioned yet — fall back to a plain text response asking the operator to
      // create a thread via the control path first.
      this.logger.warn(
        `No sandbox for thread=${stimulus.threadId} team=${stimulus.teamId} — cannot run in-sandbox turn`,
      );
      await this.say(stimulus, 'Please create a thread via the web app to start a scoping session.');
      return;
    }

    // Resolve the current session_id for this thread (resume across turns).
    const sandboxRow = await this.sandboxRows.findOne({
      where: { thread_id: stimulus.threadId, team_id: stimulus.teamId },
    });
    const sessionId = sandboxRow?.session_id ?? undefined;

    // Build the host-side tool dispatch table, scoped to this thread.
    const tools = this.buildTools(stimulus);

    // All turns run inside the Docker sandbox container.
    const runner: EngineRunnerPort = this.dockerRunner;

    const sandboxKey = `brain-${stimulus.teamId}-${stimulus.projectId}-${stimulus.threadId}`;
    const runArgs: RunEngineArgs = {
      engine: 'claude',
      task: stimulus.body,
      cwd: sandbox.worktreePath,
      systemPrompt: AgentSessionManager.SYSTEM_PROMPT,
      sandboxKey,
      mode: 'execute', // the session manages its own read-only posture via custom plan mode
      ...(sessionId ? { sessionId } : {}),
      ...(sandbox.containerId
        ? { target: { containerId: sandbox.containerId } }
        : {}),
      toolBridge: {
        threadId: stimulus.threadId,
        tools,
      },
      onEvent: (e) => {
        // Stream engine events to the web surface so the UI can render them.
        void this.streamEvent(stimulus, e);
      },
    };

    let result;
    try {
      result = await runner.run(runArgs);
    } catch (err) {
      this.logger.error(`in-sandbox turn failed for thread=${stimulus.threadId}: ${err}`);
      await this.say(stimulus, `I ran into an error — please try again. (${String(err).slice(0, 200)})`);
      return;
    }

    // Persist the session_id for resume.
    if (result.sessionId && sandboxRow) {
      sandboxRow.session_id = result.sessionId;
      await this.sandboxRows.save(sandboxRow);
    }

    // The session's final result text (if any) is the brain's reply.
    if (result.result?.trim()) {
      await this.say(stimulus, result.result.trim());
    }
  }

  // ── Host-side tool impls ───────────────────────────────────────────────────────────────────────

  /**
   * Build the 6 tool impls for a chat turn, all scoped to the stimulus's thread/team/project.
   */
  buildTools(stimulus: ChatStimulus): Record<string, ToolImpl> {
    return {
      get_pipeline_state: async (_args) => {
        return this.driverStore.getPipelineState(stimulus.threadId, stimulus.teamId);
      },

      get_decision_record: async (_args) => {
        return this.driverStore.getDecisionRecord(stimulus.threadId);
      },

      recall: async (args) => {
        const query = String(args['query'] ?? stimulus.body);
        try {
          const facts = await this.memory.recall(query, {
            scopes: [`project:${stimulus.projectId}`, `team:${stimulus.teamId}`],
            teamId: stimulus.teamId,
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
        const scope = String(args['scope'] ?? `project:${stimulus.projectId}`);
        try {
          await this.memory.remember({
            fact,
            scope,
            teamId: stimulus.teamId,
            assertedBy: stimulus.author.id,
          });
          return { stored: true };
        } catch (err) {
          return { stored: false, reason: String(err) };
        }
      },

      submit_plan: async (args) => {
        const overview = String(args['overview'] ?? '').trim();
        const rawDecisions = Array.isArray(args['decisions']) ? args['decisions'] : [];
        const rawSections = Array.isArray(args['sections']) ? args['sections'] : [];

        // Normalize decisions.
        const decisions = rawDecisions
          .filter(
            (d): d is { decisionClass: string; title: string; ruling: string } =>
              typeof d === 'object' && d !== null && 'decisionClass' in d && 'title' in d && 'ruling' in d,
          )
          .map((d) => ({
            decisionClass: d.decisionClass as import('../domain').DecisionClass,
            title: d.title,
            ruling: d.ruling,
          }));

        // Normalize sections — support both string[] and {brief,detail}[] shapes.
        const sectionBriefs = rawSections.map((s) => {
          if (typeof s === 'string') return s;
          if (typeof s === 'object' && s !== null) {
            const detail = (s as { detail?: string; brief?: string; description?: string });
            return detail.detail ?? detail.brief ?? detail.description ?? JSON.stringify(s);
          }
          return String(s);
        }).filter(Boolean);

        if (!overview || sectionBriefs.length === 0) {
          return { ok: false, reason: 'overview and at least one section are required' };
        }

        // Ensure there's an open scoping job on this thread.
        const jobId = await this.ensureJob(stimulus, overview, 'feature');

        const { job, decisionRecordId } = await this.store.persistPlan({
          teamId: stimulus.teamId,
          projectId: stimulus.projectId,
          jobId,
          title: jobTitle(overview),
          kind: 'feature',
          overview,
          decisions,
          sectionBriefs,
        });

        // ── R4: Codex plan pre-review (one-shot) ──────────────────────────────────────────────
        // First call: run a Codex review turn in the thread's sandbox → return findings to the
        // session for ONE revision.  Second call (same job): skip review → straight to approval.
        const sandbox = await this.lifecycle.findSandbox(stimulus.threadId, stimulus.teamId);
        if (sandbox) {
          const reviewResult = await this.planReview.review({
            jobId: job.id,
            teamId: stimulus.teamId,
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
    };
  }

  // ── Approval flow ──────────────────────────────────────────────────────────────────────────────

  /**
   * Post the approval card and act on the verdict — mirrors the old `ConversationalBrainService`
   * flow but without blocking the session turn on it.
   */
  async requestApprovalAndAct(
    stimulus: ChatStimulus,
    job: Job,
    decisionRecordId: string,
    card: DecisionApprovalCard,
  ): Promise<void> {
    const route = await this.store.route({
      teamId: stimulus.teamId,
      projectId: stimulus.projectId,
      threadId: stimulus.threadId,
    });
    const channel = route.channel ?? stimulus.replyRoute.threadRef;
    const threadTs = route.threadTs ?? stimulus.replyRoute.threadRef;

    const handle = await this.approvals.request(
      { channel, threadTs, teamId: stimulus.teamId },
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
      await this.dispatcher.dispatch(running);
      await this.store.appendAtlasMessage(stimulus.threadId, 'Plan approved — dispatching the build.');
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

  // ── Helpers ────────────────────────────────────────────────────────────────────────────────────


  /** Stream an engine event to the web surface for the UI. */
  private async streamEvent(stimulus: ChatStimulus, e: EngineEvent): Promise<void> {
    if (e.kind === 'text' && e.text.trim()) {
      const route = await this.store.route({
        teamId: stimulus.teamId,
        projectId: stimulus.projectId,
        threadId: stimulus.threadId,
      }).catch(() => ({ channel: null, threadTs: null }));
      const channel = route.channel ?? stimulus.replyRoute.threadRef;
      const threadTs = route.threadTs ?? stimulus.replyRoute.threadRef;
      await this.surface.post(channel, e.text, { threadTs, teamId: stimulus.teamId })
        .catch((err) => this.logger.debug(`stream event post failed: ${err}`));
    }
  }

  /** Post a reply in-thread AND append it to the durable transcript. */
  private async say(stimulus: ChatStimulus, text: string): Promise<void> {
    const route = await this.store.route({
      teamId: stimulus.teamId,
      projectId: stimulus.projectId,
      threadId: stimulus.threadId,
    });
    const channel = route.channel ?? stimulus.replyRoute.threadRef;
    const threadTs = route.threadTs ?? stimulus.replyRoute.threadRef;
    try {
      await this.surface.post(channel, text, { threadTs, teamId: stimulus.teamId });
    } catch (err) {
      this.logger.warn(`failed to post brain reply: ${err}`);
    }
    await this.store.appendAtlasMessage(stimulus.threadId, text);
  }

  /** Find the open scoping job on this thread, or open a fresh one. */
  private async ensureJob(
    stimulus: ChatStimulus,
    title: string,
    kind: Job['kind'],
  ): Promise<string> {
    const existing = await this.store.openJobOnThread(stimulus.threadId);
    if (existing) return existing;
    return this.store.openJob({
      teamId: stimulus.teamId,
      projectId: stimulus.projectId,
      threadId: stimulus.threadId,
      title: jobTitle(title),
      kind,
    });
  }
}

/** A short job title from a summary line. */
function jobTitle(summary: string): string {
  const firstLine = summary.split('\n').map((l) => l.trim()).find(Boolean) ?? summary;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}
