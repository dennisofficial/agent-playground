import type { Repository } from 'typeorm';
import type { MessageEntity } from '../persistence/entities';
import type { RecoveredBlock, TurnSlice } from './session-transcript';

/** How many trailing chars of a turn's final reply we match against `messages` to decide "already
 *  persisted". Long enough to be unique to the turn, short enough to tolerate trivial trailing differences. */
const FINAL_REPLY_FINGERPRINT_LEN = 160;

/**
 * Back-fill the durable transcript for one thread from its parsed session turns — the shared recovery core
 * behind both {@link TurnRecoveryService} (boot backstop) and the `recover-turn` CLI (one-off). Idempotent
 * and safe to re-run: a turn already durable is skipped, and individual blocks are deduped, so it never
 * double-inserts a normally-persisted or previously-recovered turn.
 *
 * Per turn, in order:
 *  - Skip the whole turn if its FINAL `chat` reply is already in `messages`. Blocks are persisted in emission
 *    order (final reply last), so "final reply present ⇒ the whole turn is present" — this is the guard that
 *    keeps normally-persisted turns from being re-inserted on every boot.
 *  - Drop INTERRUPTED tool calls (`toolPaired !== true`): a turn cut off mid-call (e.g. a dangling
 *    `ask_question`) is re-issued by the next turn, so recovering it would duplicate the card.
 *  - Dedup blocks by per-line `sdkUuid` (recovery re-run) and tool blocks by SDK tool_use id (`meta.id`,
 *    which the normal turn-harness path also persists) so a partially-persisted turn isn't doubled.
 *
 * Survivors are written as Atlas-authored rows with strictly-monotonic `created_at` seeded from each block's
 * real SDK timestamp — so a recovered turn sorts into its true position in history (e.g. between a
 * provisioning notice and a later operator prompt). Returns the number of blocks inserted.
 */
export async function backfillThreadFromTurns(
  messages: Repository<MessageEntity>,
  jobId: string,
  threadId: string,
  turns: TurnSlice[],
): Promise<number> {
  const seenSdkUuids = await persistedSdkUuids(messages, jobId);
  const seenToolIds = await persistedToolIds(messages, jobId);

  let lastMs = 0;
  let inserted = 0;

  for (const turn of turns) {
    // A turn already durable — skip it whole (final-reply fingerprint; see doc comment).
    const finalReply = [...turn.blocks]
      .reverse()
      .find((b) => b.kind === 'chat')?.text;
    if (finalReply && (await finalReplyPersisted(messages, jobId, finalReply)))
      continue;

    const fresh = turn.blocks.filter((b) =>
      isFresh(b, seenSdkUuids, seenToolIds),
    );
    if (fresh.length === 0) continue;

    for (const b of fresh) {
      // Strictly-monotonic created_at (mirrors TurnHarnessFactory.stamp) so recovered rows sort in transcript
      // order even when SDK line timestamps tie; the real timestamp keeps them positioned in true history.
      const base =
        b.emittedAt instanceof Date && !Number.isNaN(b.emittedAt.getTime())
          ? b.emittedAt.getTime()
          : Date.now();
      lastMs = Math.max(base, lastMs + 1);
      await appendBlock(messages, jobId, threadId, b, new Date(lastMs));
      // Track in-memory so a duplicate later in the SAME run (a re-issued call) is also deduped.
      if (typeof b.meta.sdkUuid === 'string') seenSdkUuids.add(b.meta.sdkUuid);
      if (b.kind === 'tool' && typeof b.meta.id === 'string' && b.meta.id)
        seenToolIds.add(b.meta.id);
      inserted++;
    }
  }

  return inserted;
}

/** Whether a recovered block should be back-filled: not an interrupted tool call, not already persisted. */
function isFresh(
  b: RecoveredBlock,
  seenSdkUuids: Set<string>,
  seenToolIds: Set<string>,
): boolean {
  // Interrupted (unpaired) tool call — the next turn re-issues it; recovering it would duplicate the card.
  if (b.kind === 'tool' && b.toolPaired !== true) return false;
  // Recovery re-run guard: same JSONL line already back-filled.
  const u = b.meta.sdkUuid;
  if (typeof u === 'string' && seenSdkUuids.has(u)) return false;
  // Tool blocks: dedup against a normally-persisted call by SDK tool_use id.
  if (b.kind === 'tool') {
    const id = b.meta.id;
    if (typeof id === 'string' && id && seenToolIds.has(id)) return false;
  }
  return true;
}

/** Write one recovered block as an Atlas-authored durable row (byte-compatible with `MessageBlockSink`). */
async function appendBlock(
  messages: Repository<MessageEntity>,
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

/** Whether a turn's final reply is already a durable Atlas message (the "already persisted" guard). */
async function finalReplyPersisted(
  messages: Repository<MessageEntity>,
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

/** The set of SDK `uuid`s already represented in this thread's durable messages — recovery-re-run guard. */
async function persistedSdkUuids(
  messages: Repository<MessageEntity>,
  jobId: string,
): Promise<Set<string>> {
  const rows: Array<{ u: string | null }> = await messages
    .createQueryBuilder('m')
    .select("m.meta ->> 'sdkUuid'", 'u')
    .where('m.job_id = :jobId', { jobId })
    .andWhere("m.meta ->> 'sdkUuid' IS NOT NULL")
    .getRawMany();
  return new Set(
    rows.map((r) => r.u).filter((u): u is string => typeof u === 'string'),
  );
}

/** The set of SDK tool_use ids (`meta.id`) already persisted for this thread — dedup vs a normal turn's
 *  tool blocks (the live turn-harness path stamps `meta.id` = the SDK tool_use id). */
async function persistedToolIds(
  messages: Repository<MessageEntity>,
  jobId: string,
): Promise<Set<string>> {
  const rows: Array<{ id: string | null }> = await messages
    .createQueryBuilder('m')
    .select("m.meta ->> 'id'", 'id')
    .where('m.job_id = :jobId', { jobId })
    .andWhere("m.kind = 'tool'")
    .andWhere("m.meta ->> 'id' IS NOT NULL")
    .getRawMany();
  return new Set(
    rows.map((r) => r.id).filter((id): id is string => typeof id === 'string'),
  );
}
