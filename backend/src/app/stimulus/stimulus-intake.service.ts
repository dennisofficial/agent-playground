import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EventMessage, Message, ParsedEvent, SeedRow } from '@shared/domain';
import { assertNever } from '@shared/domain';
import { composeMessageBody } from '../prompt-kit/harness';
import { EventFilterService } from './event-filter.service';
import { BRAIN_SINK, type BrainSink } from './stimulus-consumer';
import {
  DuplicateStimulusError,
  StimulusStoreService,
} from './stimulus-store.service';

/** Outcome of pushing an event through intake — for the controller to map to a status / log. */
export type IntakeOutcome =
  | { admitted: true; stimulusId: string; jobId: string }
  | {
      admitted: false;
      reason: 'duplicate' | 'rate-limited' | 'no-owner';
      detail: string;
    };

/**
 * The STIMULUS INTAKE SEAM — the single entry point normalized stimuli flow through:
 *
 *  - `intakeEvent(ParsedEvent)` — the `NotificationSource` path. Runs the mechanical dedup/rate-limit
 *    filter; on pass, ROUTES the event to the brain of the job that already OWNS its PR/branch (persists
 *    the event row, body fenced as untrusted, then hands the `EventMessage` to the consumer). An event
 *    that nothing owns is DROPPED — repo activity never seeds a new job (decision d6). On a filter drop,
 *    a no-owner drop, OR a DB unique-violation backstop, nothing is consumed (the firehose pays no turn).
 *  - `intakeChat(Message)` — the `ChatSurface` path. Persists the chat message + row (no filter —
 *    chat bypasses it), then hands the resulting `TurnEnvelope` to the brain.
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
      return {
        admitted: false,
        reason: verdict.reason,
        detail: verdict.detail,
      };
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
      return {
        admitted: false,
        reason: 'no-owner',
        detail: 'no job owns this event’s branch/PR',
      };
    }

    try {
      const stimulus = await this.store.attachEventToJob({
        jobId: owner.id,
        orgId: event.orgId,
        repoId: event.repoId,
        source: event.source,
        dedupeKey: event.dedupeKey,
        severity: event.severity,
        eventKind: event.eventKind,
        body: event.body,
      });
      // NOT awaited: the webhook 202 must not wait on an engine turn (which can provision a sandbox).
      // Durability is the brain's at-least-once boot sweep keyed on `stimuli.delivered_at`. `deliverEvent`
      // owns the untrusted fence (so it + the boot sweep fence identically).
      void this.sink
        .deliverEvent(stimulus)
        .catch((err) =>
          this.logger.error(`event delivery failed for ${stimulus.id}: ${err}`),
        );
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
        return {
          admitted: false,
          reason: 'duplicate',
          detail: 'db unique backstop',
        };
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
      const byPr = await this.store.findOwningJobByPrNumber(
        event.orgId,
        event.repoId,
        corr.prNumber,
      );
      if (byPr) return byPr;
    }
    if (corr.branch) {
      return this.store.findOwningJobByBranch(
        event.orgId,
        event.repoId,
        corr.branch,
      );
    }
    return null;
  }

  /**
   * Push a chat message (any non-event `Message`) continuing an existing thread into the brain. The
   * variant's `type` decides how it persists + renders; `transport` carries who authored it and where
   * Atlas replies (the caller — the chat bridge, or the future `/message` endpoint — resolves those).
   *
   * Every variant rides the SAME durable pump as ordinary chat: `recordChatStimulus` decides how it
   * renders (a plain bubble, a curated pill, or no row at all) from the `systemChunk`/`type` it's handed,
   * and the persisted `type` is the new authority for framing. No in-memory fast path — always persisted
   * first, then handed to the delivery pump (`enqueueChat`, not the old fire-and-forget `handleChat`).
   */
  async intakeChat(
    message: Exclude<Message, EventMessage>,
    transport: {
      author: { id: string; displayName: string };
      replyRoute: { surfaceId: string; jobRef: string };
      /** Render-only card payload riding alongside a PLAIN (non-seed) inbound — e.g. an operator's
       *  `attachments_card`/`review_comments_card` send. Not part of the typed `Message` shape (the
       *  clean `attachments` field on `UserMessage` supersedes this once the `/message` endpoint lands),
       *  but this legacy seam still carries it through so today's attachment/review-comment sends keep
       *  rendering. */
      card?: Record<string, unknown>;
      priority?: 'now' | 'queue' | 'later';
    },
  ): Promise<void> {
    const base = {
      orgId: message.orgId,
      repoId: message.repoId,
      jobId: message.jobId,
      author: transport.author,
      replyRoute: transport.replyRoute,
      card: transport.card,
      priority: transport.priority,
    };

    let input: RecordChatInput;
    switch (message.type) {
      case 'user':
        input = { ...base, body: message.body, type: 'user' };
        break;
      case 'answer_question': {
        const { body, seedRow } = composeMessageBody(message);
        input = {
          ...base,
          body,
          seedQuestionId: message.questionId,
          systemChunk:
            seedRow ?? genericSeedRow({ jobId: message.jobId, body }),
          type: 'answer_question',
        };
        break;
      }
      case 'file_answered': {
        const { body, seedRow } = composeMessageBody(message);
        input = {
          ...base,
          body,
          seedFileId: message.requestId,
          systemChunk:
            seedRow ?? genericSeedRow({ jobId: message.jobId, body }),
          type: 'file_answered',
        };
        break;
      }
      case 'secret_provided': {
        const { body, seedRow } = composeMessageBody(message);
        input = {
          ...base,
          body,
          seedSecretId: message.requestId,
          systemChunk:
            seedRow ?? genericSeedRow({ jobId: message.jobId, body }),
          type: 'secret_provided',
        };
        break;
      }
      case 'reset_verify':
      case 'compaction':
      case 'work_owed_nudge':
      case 'amend_approved_wake':
      case 'ship_open_pr':
      case 'request_changes':
      case 'unblocked_job_wake':
      case 'follow_up_job_seed':
      case 'retry_resume_nudge':
      case 'session_limit_reset_nudge':
      case 'mcp_approved':
      case 'mcp_removed':
      case 'convention_attached':
      case 'convention_edited':
      case 'skill_approved':
      case 'skill_edit_approved':
      case 'skill_edit_gone': {
        const { body, seedRow } = composeMessageBody(message);
        input = {
          ...base,
          body,
          systemChunk:
            seedRow ?? genericSeedRow({ jobId: message.jobId, body }),
          type: message.type,
        };
        break;
      }
      default:
        return assertNever(message);
    }

    const recorded = await this.store.recordChatStimulus(input);
    // Durable hand-off: the row is persisted; the pump owns steer-vs-turn + the delivered/sweep guarantee.
    // `enqueueChat` returns fast once enqueued — the engine turn runs behind it.
    await this.sink.enqueueChat(recorded);
  }

  /**
   * The ONE "composed multi-item send" case — an operator's own text plus the cards they answered in a
   * single submit, already framed into one pre-rendered `renderTurn(...)` body. This is NOT a `Message`
   * domain variant (see `/context/specs/data-model.md`'s "tricky corner"): it persists as `type: 'user'`
   * because the turn is operator-authored and user-last, even though its body mixes card notices with the
   * operator's chunk. The operator's note lands as its own durable operator bubble (`operatorBubbleText`),
   * NOT a "…+ a message" pill; the FULL composed turn still rides `inbound_messages.body` for the brain.
   */
  async intakeComposedSeed(
    input: {
      orgId: string;
      repoId: string;
      jobId: string;
      body: string;
      operatorBubbleText: string;
      deliveredQuestionIds?: string[];
      deliveredFileIds?: string[];
      deliveredSecretIds?: string[];
    },
    transport: {
      author: { id: string; displayName: string };
      /** The real operator identity to stamp on the `operatorBubbleText` row — independent of `author`,
       *  which stays a non-operator scope (`SYSTEM_SEED_AUTHOR`) so the composed turn keeps taking the
       *  non-operator-authored turn-composition path (see `isOperatorAuthored`). */
      bubbleAuthor: { id: string; displayName: string };
      replyRoute: { surfaceId: string; jobRef: string };
    },
  ): Promise<void> {
    const recorded = await this.store.recordChatStimulus({
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      author: transport.author,
      bubbleAuthor: transport.bubbleAuthor,
      replyRoute: transport.replyRoute,
      body: input.body,
      operatorBubbleText: input.operatorBubbleText,
      seedQuestionIds: input.deliveredQuestionIds,
      seedFileIds: input.deliveredFileIds,
      seedSecretIds: input.deliveredSecretIds,
      type: 'user',
    });
    await this.sink.enqueueChat(recorded);
  }

  /**
   * The LEGACY GENERIC SEED path — brain-side direct callers that already have a fully-rendered body and
   * a `SeedRow` render descriptor on hand (retry/resume nudges, host-retry re-drives, prod-maintenance
   * notices) and don't construct one of the 17 typed internal-seed variants. `type` is deliberately
   * omitted so `recordChatStimulus` falls through to its own author-based `'seed'` fallback (see its
   * comment) — this is the intended, still-live mechanism for this residual case, not a bypass of it.
   */
  async intakeLegacySeed(
    input: {
      orgId: string;
      repoId: string;
      jobId: string;
      body: string;
      seedRow?: SeedRow;
      seedQuestionId?: string;
      seedFileId?: string;
      seedSecretId?: string;
      seedQuestionIds?: string[];
      seedFileIds?: string[];
      seedSecretIds?: string[];
      priority?: 'now' | 'queue' | 'later';
      card?: Record<string, unknown>;
    },
    transport: {
      author: { id: string; displayName: string };
      replyRoute: { surfaceId: string; jobRef: string };
    },
  ): Promise<void> {
    const recorded = await this.store.recordChatStimulus({
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      author: transport.author,
      replyRoute: transport.replyRoute,
      body: input.body,
      systemChunk:
        input.seedRow ??
        genericSeedRow({ jobId: input.jobId, body: input.body }),
      seedQuestionId: input.seedQuestionId,
      seedFileId: input.seedFileId,
      seedSecretId: input.seedSecretId,
      seedQuestionIds: input.seedQuestionIds,
      seedFileIds: input.seedFileIds,
      seedSecretIds: input.seedSecretIds,
      priority: input.priority,
      card: input.card,
    });
    await this.sink.enqueueChat(recorded);
  }
}

type RecordChatInput = Parameters<
  StimulusStoreService['recordChatStimulus']
>[0];

function genericSeedRow(fields: {
  jobId: string;
  body: string;
}): Exclude<SeedRow, 'skip'> {
  return {
    label: 'A harness system notification was delivered to Atlas.',
    chunkKey: `seed:generic:${fields.jobId}:${createHash('sha1')
      .update(fields.body)
      .digest('hex')
      .slice(0, 16)}`,
  };
}
