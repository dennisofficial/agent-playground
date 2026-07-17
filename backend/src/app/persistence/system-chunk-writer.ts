import type { Repository } from 'typeorm';
import type { TranscriptMessageEntity } from './entities/transcript-message.entity';
import type { AgentMessage } from '@shared/prompt-kit/message';

/**
 * Shared shape of a harness-injected chunk (`system_notice` / `system_reminder` / `untrusted`) to persist
 * as a VISIBLE transcript row. Unifies the brain's `recordSystemChunk` and the driver's
 * `recordBuildSystemChunk` (d8) — both stores wrote byte-identical rows via separate copies of the same
 * insert-once-by-`chunkKey` logic.
 */
export interface SystemChunkInput {
  jobId: string;
  /** The `threads.id` row this chunk belongs to (`messages.thread_id` is NOT NULL). */
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
  /** The internal-seed `Message` type behind this row (`meta.seedType`) — the frontend's per-seed-type pill
   *  discriminant, mirroring `meta.eventKind` on an event row. Absent for a plain notice/reminder chunk. */
  seedType?: string;
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
        ...(buildCtx
          ? { phaseId: buildCtx.phaseId, legOrdinal: buildCtx.legOrdinal }
          : {}),
        chunkKey: input.chunkKey,
        ...(input.reminderKind ? { reminderKind: input.reminderKind } : {}),
        ...(input.untrustedSource
          ? { untrustedSource: input.untrustedSource }
          : {}),
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
