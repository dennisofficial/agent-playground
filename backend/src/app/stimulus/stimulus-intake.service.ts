import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ChatStimulus, ParsedEvent, SeedRow } from '../domain';
import { EventFilterService } from './event-filter.service';
import {
  BRAIN_SINK,
  type BrainSink,
} from './stimulus-consumer';
import {
  DuplicateStimulusError,
  StimulusStoreService,
} from './stimulus-store.service';

/** Outcome of pushing an event through intake — for the controller to map to a status / log. */
export type IntakeOutcome =
  | { admitted: true; stimulusId: string; jobId: string }
  | { admitted: false; reason: 'duplicate' | 'rate-limited' | 'no-owner'; detail: string };

/**
 * The STIMULUS INTAKE SEAM — the single entry point normalized stimuli flow through:
 *
 *  - `intakeEvent(ParsedEvent)` — the `NotificationSource` path. Runs the mechanical dedup/rate-limit
 *    filter; on pass, ROUTES the event to the brain of the job that already OWNS its PR/branch (persists
 *    the event row, body fenced as untrusted, then hands the `EventStimulus` to the consumer). An event
 *    that nothing owns is DROPPED — repo activity never seeds a new job (decision d6). On a filter drop,
 *    a no-owner drop, OR a DB unique-violation backstop, nothing is consumed (the firehose pays no turn).
 *  - `intakeChat(ChatStimulus)` — the `ChatSurface` path. Persists the chat message + row (no filter —
 *    chat bypasses it), then hands the `ChatStimulus` to the brain.
 *
 * The downstream is the brain (`BRAIN_SINK`): chat → the thread's session (`handleChat`); event →
 * delivered to the seeded thread's brain as a harness message (`deliverEvent`). The untrusted-content
 * fence is applied to the EVENT body before delivery — the contract lives at this single seam.
 *
 * Event delivery is deliberately NOT awaited (the webhook 202 must stay fast — a full engine turn can
 * lazily provision a sandbox); durability is the brain's at-least-once boot sweep + `stimuli.delivered_at`.
 * See `../ARCHITECTURE.md` §7.
 */
@Injectable()
export class StimulusIntake {
  private readonly logger = new Logger(StimulusIntake.name);

  constructor(
    private readonly filter: EventFilterService,
    private readonly store: StimulusStoreService,
    @Inject(BRAIN_SINK) private readonly sink: BrainSink,
  ) {}

  /**
   * Push a verified+routed event into the brain's doorstep. Filter → (pass) seed thread + persist →
   * consume. Returns the outcome so the ingress controller can answer 202-accepted vs. 202-deduped.
   */
  async intakeEvent(event: ParsedEvent): Promise<IntakeOutcome> {
    const verdict = this.filter.admit({
      orgId: event.orgId,
      repoId: event.repoId,
      source: event.source,
      dedupeKey: event.dedupeKey,
    });
    if (!verdict.pass) {
      this.logger.log(
        `event dropped (${verdict.reason}): source=${event.source} key=${event.dedupeKey} — ${verdict.detail}`,
      );
      return { admitted: false, reason: verdict.reason, detail: verdict.detail };
    }

    // ROUTE-ONLY (decision d6): an event is delivered ONLY to the brain of the job that already OWNS its
    // PR/branch — this is how a CI failure / merge conflict / review comment reaches the Atlas session
    // that can act on it. An event nothing owns (external / default-branch CI) is DROPPED, never seeds a
    // new job: repo activity must not silently spawn work. Deliberate job creation stays with the operator.
    const owner = await this.resolveOwningJob(event);
    if (!owner) {
      this.logger.log(
        `event dropped (no-owner): source=${event.source} key=${event.dedupeKey} — nothing owns this branch/PR`,
      );
      return { admitted: false, reason: 'no-owner', detail: 'no job owns this event’s branch/PR' };
    }

    try {
      const stimulus = await this.store.attachEventToJob({
        jobId: owner.id,
        orgId: event.orgId,
        repoId: event.repoId,
        source: event.source,
        dedupeKey: event.dedupeKey,
        severity: event.severity,
        body: event.body,
      });
      // NOT awaited: the webhook 202 must not wait on an engine turn (which can provision a sandbox).
      // Durability is the brain's at-least-once boot sweep keyed on `stimuli.delivered_at`. `deliverEvent`
      // owns the untrusted fence (so it + the boot sweep fence identically).
      void this.sink
        .deliverEvent(stimulus)
        .catch((err) => this.logger.error(`event delivery failed for ${stimulus.id}: ${err}`));
      this.logger.log(
        `event admitted: ${stimulus.id} routed to owning job ${owner.id} ` +
          `(project ${event.repoId}, severity ${event.severity})`,
      );
      return { admitted: true, stimulusId: stimulus.id, jobId: owner.id };
    } catch (err) {
      if (err instanceof DuplicateStimulusError) {
        // The DB unique-index backstop caught a duplicate the in-memory window missed (e.g. after a
        // restart cleared the window). Drop it — no turn paid.
        this.logger.log(
          `event dropped (db-duplicate on owning job ${owner.id}): source=${event.source} key=${event.dedupeKey}`,
        );
        return { admitted: false, reason: 'duplicate', detail: 'db unique backstop' };
      }
      throw err;
    }
  }

  /**
   * Resolve the existing job an event belongs to from its correlation hint — PR number first (most
   * specific), then branch. Null when there's no hint or nothing owns it (→ seed a new event thread).
   */
  private async resolveOwningJob(event: ParsedEvent) {
    const corr = event.correlation;
    if (!corr) return null;
    if (corr.prNumber != null) {
      const byPr = await this.store.findOwningJobByPrNumber(event.orgId, event.repoId, corr.prNumber);
      if (byPr) return byPr;
    }
    if (corr.branch) {
      return this.store.findOwningJobByBranch(event.orgId, event.repoId, corr.branch);
    }
    return null;
  }

  /**
   * Push a chat message continuing an existing thread into the brain. Persists, then consumes (no
   * filter). The caller (the chat bridge) has already resolved the thread + reply route.
   */
  async intakeChat(stimulus: ChatStimulus): Promise<void> {
    // A SYSTEM SEED (e.g. an `ask_question` answer framed as `<system_notification>`) now rides the SAME
    // durable pump as ordinary chat: `recordChatStimulus` decides how it renders (a curated pill, or no
    // row at all) from `stimulus.seedRow`, and `author.id === SYSTEM_SEED_AUTHOR.id` is what reload uses
    // to reconstruct `seed: true`. No more in-memory fast path — every chat stimulus is persisted first.
    const recorded = await this.store.recordChatStimulus({
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      jobId: stimulus.jobId,
      author: stimulus.author,
      replyRoute: stimulus.replyRoute,
      body: stimulus.body,
      card: stimulus.card,
      priority: stimulus.priority,
      systemChunk: stimulus.seed
        ? (stimulus.seedRow ?? genericSeedRow(stimulus))
        : undefined,
      seedQuestionId: stimulus.seedQuestionId,
      seedSecretId: stimulus.seedSecretId,
      seedFileId: stimulus.seedFileId,
    });
    // Durable hand-off: the row is persisted; the pump owns steer-vs-turn + the delivered/sweep guarantee.
    // NOT the old `await handleChat` (a fire-and-forget turn that could be steered into a dead engine and
    // silently lost). `enqueueChat` returns fast once enqueued — the engine turn runs behind it.
    await this.sink.enqueueChat(recorded);
  }
}

function genericSeedRow(stimulus: ChatStimulus): Exclude<SeedRow, 'skip'> {
  return {
    label: 'A harness system notification was delivered to Atlas.',
    chunkKey: `seed:generic:${stimulus.jobId}:${createHash('sha1')
      .update(stimulus.body)
      .digest('hex')
      .slice(0, 16)}`,
  };
}
