import { PrismaService } from '@lib/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { WORK_MOUNT } from '@shared/engine/paths.constants';
import type { TurnSpec } from '@shared/engine/turn-spec';
import type { InboundMessagePayload } from '@workspace/shared';
import type { InboundMessageModel } from '../../generated/prisma/models';
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

/**
 * Render one inbound row into its SDK-prompt block, per the typed `payload`. Operator text is the user turn
 * itself; other item types are structured context blocks around it. Extend the switch as item types grow.
 */
function renderInboundForPrompt(m: InboundMessageModel): string {
  const payload = m.payload as InboundMessagePayload | null;
  switch (payload?.type) {
    case 'answer_question':
      return `<answer question_id="${payload.questionId}">\n${m.text}\n</answer>`;
    case 'file_answered':
      return `<system_notice>Operator attached a file: ${payload.filename}</system_notice>`;
    case 'secret_provided':
      return `<system_notice>Operator provided a requested secret.</system_notice>`;
    case 'operator':
    default:
      return m.text;
  }
}

@Injectable()
export class TurnSpecBuilderService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly turnEnv: TurnEnvBuilder,
  ) {}

  async build(jobId: string, messages: InboundMessageModel[]): Promise<TurnSpec> {
    const { orgId, threadId } = messages[0];

    // System/background path (no request user) → unscoped reads.
    const thread = await this.prismaService.thread.findUnique({ where: { id: threadId } });

    // Every credential-owning module contributes its env slice; TurnEnvBuilder merges them (collision-checked).
    const { env, credentialsFile } = await this.turnEnv.build({ orgId, jobId });

    return {
      engine: 'claude',
      prompt: messages.map(renderInboundForPrompt).join('\n\n'),
      systemPrompt: ATLAS_BASELINE_PROMPT,
      cwd: WORK_MOUNT,
      model: DEFAULT_CLAUDE_MODEL,
      sessionId: thread?.sessionId ?? undefined,
      env,
      credentialsFile,
    };
  }
}
