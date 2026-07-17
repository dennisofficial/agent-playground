import type { Repository } from 'typeorm';
import type { TranscriptMessageEntity } from '../persistence/entities';
import type { RecoveredBlock, TurnSlice } from './session-transcript';

const FINAL_REPLY_FINGERPRINT_LEN = 160;

export async function backfillThreadFromTurns(
  messages: Repository<TranscriptMessageEntity>,
  jobId: string,
  threadId: string,
  turns: TurnSlice[],
): Promise<number> {
  const seenSdkUuids = await persistedSdkUuids(messages, jobId);
  const seenToolIds = await persistedToolIds(messages, jobId);

  let lastMs = 0;
  let inserted = 0;

  for (const turn of turns) {
    const finalReply = [...turn.blocks].reverse().find((b) => b.kind === 'chat')?.text;
    if (finalReply && (await finalReplyPersisted(messages, jobId, finalReply))) continue;

    const fresh = turn.blocks.filter((b) => isFresh(b, seenSdkUuids, seenToolIds));
    if (fresh.length === 0) continue;

    for (const b of fresh) {
      const base =
        b.emittedAt instanceof Date && !Number.isNaN(b.emittedAt.getTime())
          ? b.emittedAt.getTime()
          : Date.now();
      lastMs = Math.max(base, lastMs + 1);
      await appendBlock(messages, jobId, threadId, b, new Date(lastMs));
      if (typeof b.meta.sdkUuid === 'string') seenSdkUuids.add(b.meta.sdkUuid);
      if (b.kind === 'tool' && typeof b.meta.id === 'string' && b.meta.id)
        seenToolIds.add(b.meta.id);
      inserted++;
    }
  }

  return inserted;
}

function isFresh(b: RecoveredBlock, seenSdkUuids: Set<string>, seenToolIds: Set<string>): boolean {
  if (b.kind === 'tool' && b.toolPaired !== true) return false;
  const u = b.meta.sdkUuid;
  if (typeof u === 'string' && seenSdkUuids.has(u)) return false;
  if (b.kind === 'tool') {
    const id = b.meta.id;
    if (typeof id === 'string' && id && seenToolIds.has(id)) return false;
  }
  return true;
}

async function appendBlock(
  messages: Repository<TranscriptMessageEntity>,
  jobId: string,
  threadId: string,
  block: RecoveredBlock,
  createdAt: Date,
): Promise<void> {
  await messages.save(
    messages.create({
      job_id: jobId,
      thread_id: threadId,
      author: 'Atlas',
      author_id: 'atlas',
      author_bot_id: 'atlas',
      text: block.text ?? '',
      kind: block.kind,
      meta: block.meta,
      created_at: createdAt,
    }),
  );
}

async function finalReplyPersisted(
  messages: Repository<TranscriptMessageEntity>,
  jobId: string,
  finalReply: string,
): Promise<boolean> {
  const needle = finalReply.trim().slice(-FINAL_REPLY_FINGERPRINT_LEN);
  if (!needle) return false;
  const count = await messages
    .createQueryBuilder('m')
    .where('m.job_id = :jobId', { jobId })
    .andWhere("m.author_id = 'atlas'")
    .andWhere('position(:needle in m.text) > 0', { needle })
    .getCount();
  return count > 0;
}

async function persistedSdkUuids(
  messages: Repository<TranscriptMessageEntity>,
  jobId: string,
): Promise<Set<string>> {
  const rows: Array<{ u: string | null }> = await messages
    .createQueryBuilder('m')
    .select("m.meta ->> 'sdkUuid'", 'u')
    .where('m.job_id = :jobId', { jobId })
    .andWhere("m.meta ->> 'sdkUuid' IS NOT NULL")
    .getRawMany();
  return new Set(rows.map((r) => r.u).filter((u): u is string => typeof u === 'string'));
}

async function persistedToolIds(
  messages: Repository<TranscriptMessageEntity>,
  jobId: string,
): Promise<Set<string>> {
  const rows: Array<{ id: string | null }> = await messages
    .createQueryBuilder('m')
    .select("m.meta ->> 'id'", 'id')
    .where('m.job_id = :jobId', { jobId })
    .andWhere("m.kind = 'tool'")
    .andWhere("m.meta ->> 'id' IS NOT NULL")
    .getRawMany();
  return new Set(rows.map((r) => r.id).filter((id): id is string => typeof id === 'string'));
}
