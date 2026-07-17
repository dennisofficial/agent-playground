import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EventMessage, Message, ParsedEvent, SeedRow } from '@shared/domain';
import { assertNever } from '@shared/domain';
import { createHash } from 'node:crypto';
import { composeMessageBody } from '../prompt-kit/harness/compose-message';
import { EventFilterService } from './event-filter.service';
import { BRAIN_SINK, type BrainSink } from './stimulus-consumer';
import { DuplicateStimulusError, StimulusStoreService } from './stimulus-store.service';

export type IntakeOutcome =
  | { admitted: true; stimulusId: string; jobId: string }
  | {
      admitted: false;
      reason: 'duplicate' | 'rate-limited' | 'no-owner';
      detail: string;
    };

@Injectable()
export class StimulusIntake {
  private readonly logger = new Logger(StimulusIntake.name);

  constructor(
    private readonly filter: EventFilterService,
    private readonly store: StimulusStoreService,
    @Inject(BRAIN_SINK) private readonly sink: BrainSink,
  ) {}

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
      return this.store.findOwningJobByBranch(event.orgId, event.repoId, corr.branch);
    }
    return null;
  }

  async intakeChat(
    message: Exclude<Message, EventMessage>,
    transport: {
      author: { id: string; displayName: string };
      replyRoute: { surfaceId: string; jobRef: string };
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
          systemChunk: seedRow ?? genericSeedRow({ jobId: message.jobId, body }),
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
          systemChunk: seedRow ?? genericSeedRow({ jobId: message.jobId, body }),
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
          systemChunk: seedRow ?? genericSeedRow({ jobId: message.jobId, body }),
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
          systemChunk: seedRow ?? genericSeedRow({ jobId: message.jobId, body }),
          type: message.type,
        };
        break;
      }
      default:
        return assertNever(message);
    }

    const recorded = await this.store.recordChatStimulus(input);
    await this.sink.enqueueChat(recorded);
  }

  async intakeComposedSeed(
    input: {
      orgId: string;
      repoId: string;
      jobId: string;
      body: string;
      operatorBubbleText: string;
      card?: Record<string, unknown>;
      deliveredQuestionIds?: string[];
      deliveredFileIds?: string[];
      deliveredSecretIds?: string[];
    },
    transport: {
      author: { id: string; displayName: string };
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
      card: input.card,
      seedQuestionIds: input.deliveredQuestionIds,
      seedFileIds: input.deliveredFileIds,
      seedSecretIds: input.deliveredSecretIds,
      type: 'user',
    });
    await this.sink.enqueueChat(recorded);
  }

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
      systemChunk: input.seedRow ?? genericSeedRow({ jobId: input.jobId, body: input.body }),
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

type RecordChatInput = Parameters<StimulusStoreService['recordChatStimulus']>[0];

function genericSeedRow(fields: { jobId: string; body: string }): Exclude<SeedRow, 'skip'> {
  return {
    label: 'A harness system notification was delivered to Atlas.',
    chunkKey: `seed:generic:${fields.jobId}:${createHash('sha1')
      .update(fields.body)
      .digest('hex')
      .slice(0, 16)}`,
  };
}
