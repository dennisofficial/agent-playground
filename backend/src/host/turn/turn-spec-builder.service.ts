import { Thread } from '@lib/database/entities/thread.entity';
import { Injectable } from '@nestjs/common';
import { WORK_MOUNT } from '@shared/engine/paths.constants';
import type { TurnSpec } from '@shared/engine/turn-spec';
import { Db } from '@workspace/nestjs-rls/nest';
import type { InboundMessage } from '../../_lib/database/entities/inbound-message.entity';
import { TurnEnvBuilder } from './turn-env-builder.service';

/** Default Claude model for a turn until per-profile model selection lands.
 * TODO: Temporary
 */
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';

/** Minimal Atlas baseline system prompt — the real profile-derived prompt is a later concern.
 * TODO: Temporary
 */
const ATLAS_BASELINE_PROMPT = [
  'You are an Atlas coding agent working inside a sandboxed clone of the user’s repository at /workspace.',
  'Complete the requested task directly, using the tools available to you.',
].join('\n');

@Injectable()
export class TurnSpecBuilder {
  constructor(
    private readonly db: Db,
    private readonly turnEnv: TurnEnvBuilder,
  ) {}

  async build(jobId: string, messages: InboundMessage[]): Promise<TurnSpec> {
    const { orgId, threadId } = messages[0];

    // System/background path (no request user) → unscoped reads.
    const thread = await this.db.unsafe(Thread).findOne({ where: { id: threadId } });

    // Every credential-owning module contributes its env slice; TurnEnvBuilder merges them (collision-checked).
    const { env, credentialsFile } = await this.turnEnv.build({ orgId, jobId });

    return {
      engine: 'claude',
      prompt: messages.map((m) => m.text).join('\n\n'),
      systemPrompt: ATLAS_BASELINE_PROMPT,
      cwd: WORK_MOUNT,
      model: DEFAULT_CLAUDE_MODEL,
      sessionId: thread?.sessionId ?? undefined,
      env,
      credentialsFile,
    };
  }
}
