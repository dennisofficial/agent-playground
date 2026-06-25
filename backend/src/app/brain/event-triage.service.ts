import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DecisionClassifier,
  ParkAndAskService,
  type ClassifierRecord,
} from '../decision-gate';
import type { EventStimulus, Thread } from '../domain';
import { BRAIN_LLM, type BrainLlm } from './brain-llm';
import { BrainStoreService } from './brain-store.service';
import { JOB_DISPATCHER, type JobDispatcher } from './job-dispatcher';

/**
 * R3 — EVENT TRIAGE (extracted verbatim from the TriageService event lane).
 *
 * Handles untrusted notification events: triage LLM verdict → always-ask classifier → park-and-ask OR
 * autonomous bugfix dispatch. The SECURITY CONTROL (always-ask gate) is unchanged. This extraction
 * is purely structural — the event behavior is identical to the old TriageService.triageEvent path;
 * no logic changed.
 */
@Injectable()
export class EventTriageService {
  private readonly logger = new Logger(EventTriageService.name);

  constructor(
    @Inject(BRAIN_LLM) private readonly llm: BrainLlm,
    private readonly classifier: DecisionClassifier,
    private readonly parkAndAsk: ParkAndAskService,
    private readonly store: BrainStoreService,
    @Inject(JOB_DISPATCHER) private readonly dispatcher: JobDispatcher,
  ) {}

  /**
   * Triage an untrusted notification event. The body is DATA, already fenced. `ignore` drops it;
   * `ask` / `dispatch` route through the always-ask gate before any work happens — a clean bugfix
   * dispatches, an always-ask (or injected destructive ask) PARKS.
   */
  async triageEvent(stimulus: EventStimulus): Promise<void> {
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
      orgId: stimulus.orgId,
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
      stimulus.orgId,
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
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
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
    await this.store.openJob({
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      threadId,
      title: jobTitle(summary),
      kind: 'bugfix',
    });
    // A bugfix has one section and no upfront decision record (the gate already cleared it).
    const { thread } = await this.store.persistPlan({
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      threadId,
      title: jobTitle(summary),
      kind: 'bugfix',
      overview: summary,
      decisions: [],
      // Autonomous bugfix: one section, the summary IS the work.
      sectionBriefs: [summary],
    });
    const running = await this.store.approve(thread.id, requireRecordId(thread), 'atlas:autonomous');
    await this.dispatcher.dispatch(running);
    this.logger.log(`event ${stimulus.id} dispatched as autonomous bugfix on thread ${thread.id}.`);
  }
}

/** A `Thread` scoped by `persistPlan` always has a decision record id. */
function requireRecordId(thread: Thread): string {
  if (!thread.decisionRecordId) {
    throw new Error(`thread ${thread.id} has no decision record id after persistPlan`);
  }
  return thread.decisionRecordId;
}

/** A short job title from a summary line. */
function jobTitle(summary: string): string {
  const firstLine = summary.split('\n').map((l) => l.trim()).find(Boolean) ?? summary;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}
