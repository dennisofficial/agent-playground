import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ChatStimulus, ParsedEvent } from '../domain';
import { EventFilterService } from './event-filter.service';
import {
  STIMULUS_CONSUMER,
  type StimulusConsumer,
} from './stimulus-consumer';
import {
  DuplicateStimulusError,
  StimulusStoreService,
} from './stimulus-store.service';
import { SurfaceOrchestration } from './surface-orchestration.service';
import { wrapUntrusted } from './untrusted-content';

/** Outcome of pushing an event through intake — for the controller to map to a status / log. */
export type IntakeOutcome =
  | { admitted: true; stimulusId: string; threadId: string }
  | { admitted: false; reason: 'duplicate' | 'rate-limited'; detail: string };

/**
 * The STIMULUS INTAKE SEAM — the single injectable normalized stimuli flow INTO and through which the
 * brain (W3) is reached. Both edges converge here:
 *
 *  - `intakeEvent(ParsedEvent)` — the `NotificationSource` path. Runs the mechanical dedup/rate-limit
 *    filter; on pass, SEEDS a new thread + persists the event row (the body fenced as untrusted),
 *    then hands the `EventStimulus` to the consumer. On a filter drop OR a DB unique-violation
 *    backstop, nothing is consumed (the firehose pays no Atlas turn).
 *  - `intakeChat(ChatStimulus)` — the `ChatSurface` path. Persists the chat message + row (no filter —
 *    chat bypasses it), then hands the `ChatStimulus` to the consumer.
 *
 * The consumer is a port (`STIMULUS_CONSUMER`): W2 binds a logging no-op so the pipeline is observable
 * end-to-end; W3 swaps in real triage with zero changes here. The untrusted-content fence is applied
 * to the EVENT body before it reaches the consumer — the contract lives at this single seam. Zero v1
 * imports.
 */
@Injectable()
export class StimulusIntake {
  private readonly logger = new Logger(StimulusIntake.name);

  constructor(
    private readonly filter: EventFilterService,
    private readonly store: StimulusStoreService,
    private readonly orchestration: SurfaceOrchestration,
    @Inject(STIMULUS_CONSUMER) private readonly consumer: StimulusConsumer,
  ) {}

  /**
   * Push a verified+routed event into the brain's doorstep. Filter → (pass) seed thread + persist →
   * consume. Returns the outcome so the ingress controller can answer 202-accepted vs. 202-deduped.
   */
  async intakeEvent(event: ParsedEvent): Promise<IntakeOutcome> {
    const verdict = this.filter.admit({
      teamId: event.teamId,
      projectId: event.projectId,
      source: event.source,
      dedupeKey: event.dedupeKey,
    });
    if (!verdict.pass) {
      this.logger.log(
        `event dropped (${verdict.reason}): source=${event.source} key=${event.dedupeKey} — ${verdict.detail}`,
      );
      return { admitted: false, reason: verdict.reason, detail: verdict.detail };
    }

    try {
      const title = deriveTitle(event);
      const seeded = await this.store.seedEventThread({
        teamId: event.teamId,
        projectId: event.projectId,
        source: event.source,
        dedupeKey: event.dedupeKey,
        severity: event.severity,
        body: event.body,
        title,
      });

      // ANNOUNCE-IN-TIMELINE (W6): post the headline TOP-LEVEL and backfill the thread's
      // surface_thread_ref with the announcement ts BEFORE the brain triages — so every downstream
      // post (triage ack, park-and-ask, the driver's chatter) threads off it with no code changes.
      // Best-effort: a failed/no-op announcement leaves the ref null (downstream falls back to top-level).
      await this.orchestration
        .announceEvent({
          teamId: event.teamId,
          projectId: event.projectId,
          threadId: seeded.thread.id,
          source: event.source,
          severity: event.severity,
          title,
        })
        .catch((err) => this.logger.warn(`announce failed (continuing): ${err}`));

      // The brain triages the FENCED body — untrusted data, never instructions. The contract lives
      // here so every consumer (W3 triage today, anything later) gets the same fenced text.
      await this.consumer.consume({
        ...seeded.stimulus,
        body: wrapUntrusted({
          source: event.source,
          severity: event.severity,
          body: seeded.stimulus.body,
        }),
      });

      this.logger.log(
        `event admitted: ${seeded.stimulus.id} seeded thread ${seeded.thread.id} ` +
          `(project ${event.projectId}, severity ${event.severity})`,
      );
      return { admitted: true, stimulusId: seeded.stimulus.id, threadId: seeded.thread.id };
    } catch (err) {
      if (err instanceof DuplicateStimulusError) {
        // The DB unique-index backstop caught a duplicate the in-memory window missed (e.g. after a
        // restart cleared the window). Drop it — no thread seeded, no turn paid.
        this.logger.log(
          `event dropped (db-duplicate): source=${event.source} key=${event.dedupeKey}`,
        );
        return { admitted: false, reason: 'duplicate', detail: 'db unique backstop' };
      }
      throw err;
    }
  }

  /**
   * Push a chat message continuing an existing thread into the brain. Persists, then consumes (no
   * filter). The caller (the chat bridge) has already resolved the thread + reply route.
   */
  async intakeChat(stimulus: ChatStimulus): Promise<void> {
    const recorded = await this.store.recordChatStimulus({
      teamId: stimulus.teamId,
      projectId: stimulus.projectId,
      threadId: stimulus.threadId,
      author: stimulus.author,
      replyRoute: stimulus.replyRoute,
      body: stimulus.body,
    });
    await this.consumer.consume(recorded);
  }
}

/** A short human-readable thread title from the event — first non-empty line of the body, truncated. */
function deriveTitle(event: ParsedEvent): string {
  const firstLine = event.body.split('\n').map((l) => l.trim()).find(Boolean) ?? event.source;
  const trimmed = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  return `[${event.source}] ${trimmed}`;
}
