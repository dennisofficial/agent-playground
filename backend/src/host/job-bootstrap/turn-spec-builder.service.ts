import { Injectable } from '@nestjs/common';
import type { InboundMessage } from '../../_lib/database/entities/inbound-message.entity';
import type { TurnSpec } from '../../_shared/engine/turn-spec';

/**
 * Thin seam that turns a claimed batch of inbound messages into a `TurnSpec` (engine, prompt, system
 * prompt, auth, cwd, …). A real implementation — assembling the system prompt from the WorkspaceProfile,
 * resolving agent credentials, threading the session id — lands in a later sequence. For S1 it throws so
 * the shape exists and is mockable in `TurnRunnerService` tests.
 */
@Injectable()
export class TurnSpecBuilder {
  async build(jobId: string, messages: InboundMessage[]): Promise<TurnSpec> {
    throw new Error('TurnSpecBuilder.build not implemented (S1)');
  }
}
