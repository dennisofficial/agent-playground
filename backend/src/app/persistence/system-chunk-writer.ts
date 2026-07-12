import type { Repository } from 'typeorm';
import type { MessageEntity } from './entities/message.entity';
import type { AgentMessage } from '../prompt-kit/message';

/**
 * Shared shape of a harness-injected chunk (`system_notice` / `system_reminder` / `untrusted`) to persist
 * as a VISIBLE transcript row. Unifies the brain's `recordSystemChunk` and the driver's
 * `recordBuildSystemChunk` (d8) — both stores wrote byte-identical rows via separate copies of the same
 * insert-once-by-`chunkKey` logic.
 */
export interface SystemChunkInput {
  jobId: string;
  kind: 'system_notice' | 'system_reminder' | 'untrusted';
  text: AgentMessage;
  chunkKey: string;
  reminderKind?: string;
  untrustedSource?: string;
  severity?: string;
  fullBody?: AgentMessage;
  framing?: string;
  createdAt?: Date;
}

/** The build-lane coordinate the driver tags its rows with; absent on the brain's main-lane chunks. */
export interface SystemChunkBuildContext {
  phaseId: string;
  legOrdinal: number;
}

/**
 * Insert-once (by `input.chunkKey`, scoped to `input.jobId`) a System-authored `chat` row for a
 * harness-injected chunk. A plain function taking the repo as an argument — not a Nest provider — so the
 * brain and driver stores (each on their own `MessageEntity` repository) can share this without a DI edge
 * between them.
 */
export async function writeSystemChunk(
  repo: Repository<MessageEntity>,
  input: SystemChunkInput,
  buildCtx?: SystemChunkBuildContext,
): Promise<void> {
  const dup = await repo
    .createQueryBuilder('m')
    .where('m.job_id = :jobId', { jobId: input.jobId })
    .andWhere('m.meta @> :key::jsonb', {
      key: JSON.stringify({ chunkKey: input.chunkKey }),
    })
    .getCount();
  if (dup > 0) return;
  await repo.save(
    repo.create({
      job_id: input.jobId,
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
      },
      ...(input.createdAt ? { created_at: input.createdAt } : {}),
    }),
  );
}
