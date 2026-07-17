import type { AgentMessage } from '@shared/prompt-kit/message';
import type { Repository } from 'typeorm';
import type { TranscriptMessageEntity } from './entities/transcript-message.entity';

export interface SystemChunkInput {
  jobId: string;
  threadId: string;
  kind: 'system_notice' | 'system_reminder' | 'untrusted';
  text: AgentMessage;
  chunkKey: string;
  reminderKind?: string;
  untrustedSource?: string;
  severity?: string;
  fullBody?: AgentMessage;
  framing?: string;
  createdAt?: Date;
  seedType?: string;
}

export interface SystemChunkBuildContext {
  phaseId: string;
  legOrdinal: number;
}

export async function writeSystemChunk(
  repo: Repository<TranscriptMessageEntity>,
  input: SystemChunkInput,
  buildCtx?: SystemChunkBuildContext,
): Promise<string | null> {
  const dup = await repo
    .createQueryBuilder('m')
    .where('m.job_id = :jobId', { jobId: input.jobId })
    .andWhere('m.meta @> :key::jsonb', {
      key: JSON.stringify({ chunkKey: input.chunkKey }),
    })
    .getCount();
  if (dup > 0) return null;
  const row = await repo.save(
    repo.create({
      job_id: input.jobId,
      thread_id: input.threadId,
      author: 'System',
      author_id: 'U-SYSTEM',
      author_bot_id: null,
      text: input.text,
      kind: 'chat',
      meta: {
        source: input.kind,
        ...(buildCtx ? { phaseId: buildCtx.phaseId, legOrdinal: buildCtx.legOrdinal } : {}),
        chunkKey: input.chunkKey,
        ...(input.reminderKind ? { reminderKind: input.reminderKind } : {}),
        ...(input.untrustedSource ? { untrustedSource: input.untrustedSource } : {}),
        ...(input.severity ? { severity: input.severity } : {}),
        ...(input.fullBody ? { fullBody: input.fullBody } : {}),
        ...(input.framing ? { framing: input.framing } : {}),
        ...(input.seedType ? { seedType: input.seedType } : {}),
      },
      ...(input.createdAt ? { created_at: input.createdAt } : {}),
    }),
  );
  return row.id;
}
