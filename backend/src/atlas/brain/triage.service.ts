import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DecisionClassifier,
  ParkAndAskService,
  type ClassifierRecord,
} from '../decision-gate';
import type { ChatStimulus, EventStimulus, Job, Stimulus } from '../domain';
import { type StimulusConsumer } from '../stimulus';
import { ATLAS_BRAIN_LLM, type BrainLlm } from './brain-llm';
import { BrainStoreService } from './brain-store.service';
import { ConversationalBrainService } from './conversational-brain.service';
import { JOB_DISPATCHER, type JobDispatcher } from './job-dispatcher';

/**
 * W3 — TRIAGE. The brain's intake doorstep, bound as the `STIMULUS_CONSUMER` (replacing W2's logging
 * no-op). For each surviving stimulus it runs ONE cheap triage turn → ignore / ask / dispatch:
 *
 *  - CHAT (trusted, from the operator) drives the conversational flow: an actionable chat opens / continues
 *    a scoping conversation in the `ConversationalBrainService` (the grill). Pure noise is ignored.
 *  - EVENT (untrusted notification) is triaged as DATA, never instructions (the body is already fenced).
 *    The always-ask decision-class gate is the SECURITY CONTROL: a clean bugfix (no always-ask touched)
 *    may dispatch straight to the driver; anything touching an always-ask class — including an injected
 *    "go delete prod" — PARKS & asks rather than executing.
 *
 * Legible by construction: a small structured turn decides whether/what; HOW is the driver's (W4).
 * Zero v1 imports.
 */
@Injectable()
export class TriageService implements StimulusConsumer {
  private readonly logger = new Logger(TriageService.name);

  constructor(
    @Inject(ATLAS_BRAIN_LLM) private readonly llm: BrainLlm,
    private readonly brain: ConversationalBrainService,
    private readonly classifier: DecisionClassifier,
    private readonly parkAndAsk: ParkAndAskService,
    private readonly store: BrainStoreService,
    @Inject(JOB_DISPATCHER) private readonly dispatcher: JobDispatcher,
  ) {}

  /** Called once per surviving stimulus (after normalization + persistence). */
  async consume(stimulus: Stimulus): Promise<void> {
    if (stimulus.kind === 'chat') {
      await this.triageChat(stimulus);
    } else {
      await this.triageEvent(stimulus);
    }
  }

  /**
   * Triage a trusted chat message. An actionable message opens / continues a scoping conversation; pure
   * noise is ignored. (A chat in an already-open scoping thread always continues the grill — the human
   * is mid-conversation.)
   */
  private async triageChat(stimulus: ChatStimulus): Promise<void> {
    // Already scoping this thread → keep grilling; don't re-triage mid-conversation.
    const openJob = await this.store.openJobOnThread(stimulus.threadId);
    if (openJob) {
      await this.brain.handleChatTurn(stimulus);
      return;
    }

    const action = await this.llm.triage({ kind: 'chat', body: stimulus.body });
    // No key / malformed → treat an opening chat as actionable (open a conversation), never silently drop.
    if (!action || action.verb !== 'ignore') {
      this.logger.log(
        `chat triaged → ${action?.verb ?? 'ask (no-llm default)'}: ${action?.reason ?? stimulus.body.slice(0, 60)}`,
      );
      // Anchor the grill with a `scoping` job NOW, so every follow-up in this thread continues the
      // conversation (it matches `openJobOnThread` above) instead of being re-triaged turn-by-turn — a
      // re-triaged answer like "use your best judgment" otherwise reads as a non-actionable meta-instruction
      // and gets dropped, killing the grill. `propose_plan`'s `ensureJob` reuses this same job and
      // `persistPlan` sets the real kind/title; a provisional `feature` kind is fine.
      await this.store.openJob({
        teamId: stimulus.teamId,
        projectId: stimulus.projectId,
        threadId: stimulus.threadId,
        title: title(stimulus.body),
        kind: 'feature',
      });
      await this.brain.handleChatTurn(stimulus);
      return;
    }
    this.logger.log(`chat ignored: ${action.reason}`);
  }

  /**
   * Triage an untrusted notification event. The body is DATA, already fenced. `ignore` drops it;
   * `ask` / `dispatch` route through the always-ask gate before any work happens — a clean bugfix
   * dispatches, an always-ask (or injected destructive ask) PARKS.
   */
  private async triageEvent(stimulus: EventStimulus): Promise<void> {
    // The intake seam seeded a thread for this event; resolve its id (the in-memory shape doesn't carry it).
    const threadId = await this.store.eventThreadId(stimulus.id);
    if (!threadId) {
      this.logger.warn(`event ${stimulus.id} has no seeded thread — cannot triage; dropping.`);
      return;
    }

    const action = await this.llm.triage({
      kind: 'event',
      body: stimulus.body,
      source: stimulus.source,
      severity: stimulus.severity,
    });

    // No usable verdict → conservative: PARK and ask a human (never auto-dispatch unverified events).
    if (!action) {
      await this.parkEvent(stimulus, threadId, 'Unverified event — needs a human look before I act on it.');
      return;
    }

    if (action.verb === 'ignore') {
      this.logger.log(`event ${stimulus.id} ignored: ${action.reason}`);
      return;
    }

    const summary = action.summary ?? stimulus.body.slice(0, 200);

    // The always-ask gate is the security control. Classify the PROPOSED action (the model's summary of
    // what to do), NOT the raw untrusted body — so an injected "delete prod" surfaces as an always-ask
    // class and parks. An empty decision record means nothing is pre-covered (the event opened a new job).
    const emptyRecord: ClassifierRecord = { decisions: [] };
    const verdict = await this.classifier.classify(
      { description: summary, context: `Notification from ${stimulus.source} (${stimulus.severity}).` },
      emptyRecord,
    );

    if (action.verb === 'ask' || verdict.verdict === 'ask') {
      await this.parkEvent(
        stimulus,
        threadId,
        `${summary}\n\n${verdict.reason} I'll hold until you confirm — should I proceed?`,
      );
      return;
    }

    // Clean + actionable + no always-ask touched → autonomous bugfix straight to the driver.
    await this.dispatchBugfix(stimulus, threadId, summary);
  }

  /** Park an event on its seeded thread and ask the human (the autonomous always-ask branch). */
  private async parkEvent(
    stimulus: EventStimulus,
    threadId: string,
    question: string,
  ): Promise<void> {
    const route = await this.store.route({
      teamId: stimulus.teamId,
      projectId: stimulus.projectId,
      threadId,
    });
    if (!route.channel) {
      this.logger.warn(`event ${stimulus.id} has no bound channel — cannot park; dropping.`);
      return;
    }
    await this.parkAndAsk.ask(
      { channel: route.channel, ...(route.threadTs ? { threadTs: route.threadTs } : {}) },
      question,
    );
    this.logger.log(`event ${stimulus.id} parked & asked (always-ask / unverified).`);
  }

  /**
   * Dispatch a clean autonomous bugfix: a 1-section job (no decision record, nothing always-ask), handed
   * straight to the `JOB_DISPATCHER` (W4 driver). The seeded event thread is the job's thread.
   */
  private async dispatchBugfix(
    stimulus: EventStimulus,
    threadId: string,
    summary: string,
  ): Promise<void> {
    const jobId = await this.store.openJob({
      teamId: stimulus.teamId,
      projectId: stimulus.projectId,
      threadId,
      title: title(summary),
      kind: 'bugfix',
    });
    // A bugfix has one section and no upfront decision record (the gate already cleared it).
    const { job } = await this.store.persistPlan({
      teamId: stimulus.teamId,
      projectId: stimulus.projectId,
      jobId,
      title: title(summary),
      kind: 'bugfix',
      overview: summary,
      decisions: [],
      sectionBriefs: [summary],
    });
    const running = await this.store.approve(job.id, requireRecordId(job), 'atlas:autonomous');
    await this.dispatcher.dispatch(running);
    this.logger.log(`event ${stimulus.id} dispatched as autonomous bugfix job ${job.id}.`);
  }
}

/** A `Job` produced by `persistPlan` always has a decision record id. */
function requireRecordId(job: Job): string {
  if (!job.decisionRecordId) throw new Error(`job ${job.id} has no decision record id after persistPlan`);
  return job.decisionRecordId;
}

/** A short job title from a summary line. */
function title(summary: string): string {
  const firstLine = summary.split('\n').map((l) => l.trim()).find(Boolean) ?? summary;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}
