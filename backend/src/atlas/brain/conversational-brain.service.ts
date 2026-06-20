import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ChatStimulus, Job } from '../domain';
import { AtlasMemoryStore } from '../memory';
import { CHAT_SURFACE, type ChatSurface, type DecisionApprovalCard } from '../surface';
import { ATLAS_BRAIN_LLM, type BrainLlm } from './brain-llm';
import { BrainStoreService } from './brain-store.service';
import { DecisionApprovalService } from './decision-approval.service';
import { JOB_DISPATCHER, type JobDispatcher } from './job-dispatcher';
import { ScopingInvestigatorService } from './scoping-investigator.service';

/**
 * W3 — the CONVERSATIONAL BRAIN (the grill). Handles ONE chat turn in a scoping thread: it reads the
 * thread transcript + relevant memory, runs a single structured grill turn (a typed action, NOT a tool
 * loop), and either:
 *   - asks the next clarifying question in-thread (walking the always-ask decision classes), or
 *   - proposes a LOCKED plan (decision record + high-level section list) → the approval gate.
 *
 * On approval it hands the job to `JOB_DISPATCHER` (the W4 seam). On rejection / change-request it
 * returns the job to scoping — the human's next message re-grills with the new context. The brain is
 * deliberately legible: it owns WHETHER/WHAT (ask, propose, dispatch), never HOW (the section/phase
 * driver is W4). Zero v1 imports.
 */
@Injectable()
export class ConversationalBrainService {
  private readonly logger = new Logger(ConversationalBrainService.name);

  constructor(
    @Inject(ATLAS_BRAIN_LLM) private readonly llm: BrainLlm,
    private readonly store: BrainStoreService,
    private readonly memory: AtlasMemoryStore,
    private readonly approvals: DecisionApprovalService,
    private readonly investigator: ScopingInvestigatorService,
    @Inject(JOB_DISPATCHER) private readonly dispatcher: JobDispatcher,
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
  ) {}

  /**
   * Handle one chat stimulus continuing a scoping thread. The inbound message is already persisted to
   * `atlas_messages` (by the intake seam), so the transcript already includes it. Runs one grill turn;
   * see the class doc for the branches. Triage routes a feature/ambiguous chat here.
   */
  async handleChatTurn(stimulus: ChatStimulus): Promise<void> {
    const transcript = await this.store.transcript(stimulus.threadId);
    const [recalled, repoDigest] = await Promise.all([
      this.recall(stimulus),
      // Ground the grill in the ACTUAL repo so it stops interrogating the operator for self-answerable
      // facts (issue #1). Cached per thread; fails soft to '' (then the grill proceeds ungrounded).
      this.investigator.digest({
        teamId: stimulus.teamId,
        projectId: stimulus.projectId,
        threadId: stimulus.threadId,
        focus: stimulus.body,
      }),
    ]);

    const action = await this.llm.grill({ transcript, recalled, repoDigest });

    // No usable model verdict (no key / malformed) → ask a generic clarifier rather than guess a plan.
    if (!action) {
      await this.say(
        stimulus,
        "I need a bit more to scope this. What's the goal, and are there any constraints I should know about?",
      );
      return;
    }

    if (action.verb === 'ask_question') {
      await this.say(stimulus, action.question);
      return;
    }

    // propose_plan — lock the decision record + section list, post the approval card, await the verdict.
    const jobId = await this.ensureJob(stimulus, action.title, action.kind);
    const { job, decisionRecordId } = await this.store.persistPlan({
      teamId: stimulus.teamId,
      projectId: stimulus.projectId,
      jobId,
      title: action.title,
      kind: action.kind,
      overview: action.overview,
      decisions: action.decisions,
      sectionBriefs: action.sectionBriefs,
    });

    await this.requestApprovalAndAct(stimulus, job, decisionRecordId, {
      jobId,
      decisionRecordId,
      title: action.title,
      summary: action.overview,
      sections: action.sectionBriefs,
    });
  }

  /**
   * Answer a non-work QUESTION about the repo (issue #6) — a repo-grounded conversational reply, NO job.
   * Triage routes "what does this repo do?"-style messages here. Falls back to a gentle clarifier when the
   * investigation comes back empty (no repo / no key).
   */
  async answerQuestion(stimulus: ChatStimulus): Promise<void> {
    const answer = await this.investigator.answer({
      teamId: stimulus.teamId,
      projectId: stimulus.projectId,
      question: stimulus.body,
    });
    await this.say(
      stimulus,
      answer ||
        "I couldn't pull enough from the repo to answer that confidently — can you add a little more detail?",
    );
  }

  /**
   * Post the approval card into the thread and act on the verdict: approve → mark approved + dispatch;
   * request_changes / deny → return to scoping (re-grill on the next message) / cancel. The brain
   * awaits the verdict (the section build does NOT block on it — dispatch returns promptly).
   */
  private async requestApprovalAndAct(
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
    const channel = route.channel ?? stimulus.replyRoute.threadRef; // fall back to the reply route
    const threadTs = route.threadTs ?? stimulus.replyRoute.threadRef;

    const handle = await this.approvals.request(
      { channel, threadTs },
      card,
    );

    let resolution;
    try {
      resolution = await handle.verdict;
    } catch (err) {
      // Shutdown / cancel rejected the wait — leave the job awaiting_approval for boot rehydration.
      this.logger.warn(`approval wait abandoned for job ${job.id}: ${err}`);
      return;
    }

    if (resolution.verdict === 'approve') {
      const running = await this.store.approve(job.id, decisionRecordId, resolution.ruledBy);
      this.investigator.forget(stimulus.threadId);
      await this.dispatcher.dispatch(running);
      await this.store.appendAtlasMessage(stimulus.threadId, 'Plan approved — dispatching the build.');
      return;
    }

    if (resolution.verdict === 'request_changes') {
      await this.store.reopenScoping(job.id);
      const note = resolution.note ? ` Noted: ${resolution.note}` : '';
      await this.say(stimulus, `Got it — back to the drawing board.${note} What should change?`);
      return;
    }

    // deny
    this.investigator.forget(stimulus.threadId);
    await this.store.cancel(job.id);
    await this.say(stimulus, 'Understood — I\'ll drop this one.');
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
      title,
      kind,
    });
  }

  /** Post a reply in-thread AND append it to the durable transcript so the next turn sees it. */
  private async say(stimulus: ChatStimulus, text: string): Promise<void> {
    const route = await this.store.route({
      teamId: stimulus.teamId,
      projectId: stimulus.projectId,
      threadId: stimulus.threadId,
    });
    const channel = route.channel ?? stimulus.replyRoute.threadRef;
    const threadTs = route.threadTs ?? stimulus.replyRoute.threadRef;
    try {
      await this.surface.post(channel, text, { threadTs });
    } catch (err) {
      this.logger.warn(`failed to post brain reply: ${err}`);
    }
    await this.store.appendAtlasMessage(stimulus.threadId, text);
  }

  /** Recall project- + team-scoped memory relevant to this turn's body. */
  private async recall(stimulus: ChatStimulus): Promise<string[]> {
    try {
      const facts = await this.memory.recall(stimulus.body, {
        scopes: [`project:${stimulus.projectId}`, `team:${stimulus.teamId}`],
        teamId: stimulus.teamId,
        limit: 5,
      });
      return facts.map((f) => f.fact);
    } catch (err) {
      this.logger.debug(`recall failed (continuing without memory): ${err}`);
      return [];
    }
  }
}
