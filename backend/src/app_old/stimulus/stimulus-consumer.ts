import { Logger } from '@nestjs/common';
import type { EventMessage, TurnEnvelope } from '../../_shared/domain';

export const BRAIN_SINK = Symbol('BRAIN_SINK');

export interface BrainSink {
  handleChat(envelope: TurnEnvelope): Promise<void>;
  enqueueChat(envelope: TurnEnvelope): Promise<void>;
  deliverEvent(event: EventMessage): Promise<void>;
}

export class LoggingBrainSink implements BrainSink {
  private readonly logger = new Logger('BrainSink');

  async handleChat(envelope: TurnEnvelope): Promise<void> {
    this.logger.log(
      `[no-op] CHAT SEED ${envelope.id} thread=${envelope.jobId} ` +
        `author=${envelope.author.displayName} project=${envelope.repoId}`,
    );
  }

  async enqueueChat(envelope: TurnEnvelope): Promise<void> {
    this.logger.log(
      `[no-op] CHAT ${envelope.id} thread=${envelope.jobId} ` +
        `author=${envelope.author.displayName} project=${envelope.repoId}`,
    );
  }

  async deliverEvent(event: EventMessage): Promise<void> {
    this.logger.log(
      `[no-op] EVENT ${event.id} source=${event.source} severity=${event.severity} ` +
        `thread=${event.jobId} project=${event.repoId} (untrusted)`,
    );
  }
}
