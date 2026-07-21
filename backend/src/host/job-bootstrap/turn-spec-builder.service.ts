import { Thread } from '@lib/database/entities/thread.entity';
import { Injectable } from '@nestjs/common';
import type { EngineAuth } from '@workspace/agent-engine';
import { Db } from '@workspace/nestjs-rls/nest';
import { EAgentCredentialKind, EAgentProvider } from '@workspace/shared';
import type { InboundMessage } from '../../_lib/database/entities/inbound-message.entity';
import type { TurnSpec } from '../../_shared/engine/turn-spec';
import { AgentCredentialResolver } from '../agent-credentials/agent-credential-resolver.service';

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
    private readonly credentials: AgentCredentialResolver,
  ) {}

  async build(jobId: string, messages: InboundMessage[]): Promise<TurnSpec> {
    const { orgId, threadId } = messages[0];

    // System/background path (no request user) → unscoped read.
    const thread = await this.db.unsafe(Thread).findOne({ where: { id: threadId } });

    const resolved = await this.credentials.resolve(orgId, EAgentProvider.CLAUDE);
    if (!resolved) throw new Error(`no Claude credential selected for org ${orgId}`);

    const auth: EngineAuth = {
      secret: resolved.material,
      kind: TurnSpecBuilder.mapKind(resolved.kind),
      // No `refreshBack`: setup-token has none, and personal write-back is deferred.
    };

    return {
      engine: 'claude',
      prompt: messages.map((m) => m.text).join('\n\n'),
      systemPrompt: ATLAS_BASELINE_PROMPT,
      cwd: '/workspace',
      model: DEFAULT_CLAUDE_MODEL,
      sessionId: thread?.sessionId ?? undefined,
      auth,
    };
  }

  private static mapKind(kind: EAgentCredentialKind): EngineAuth['kind'] {
    return kind === EAgentCredentialKind.PERSONAL ? 'personal' : 'setup-token';
  }
}
