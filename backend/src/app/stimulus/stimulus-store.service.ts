import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, QueryFailedError, Repository } from 'typeorm';
import type {
  ChatStimulus,
  EventStimulus,
  SeedRow,
} from '../domain';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  MessageEntity,
  StimulusEntity,
  JobEntity,
} from '../persistence/entities';
import { SYSTEM_SEED_AUTHOR } from '../surface/chat-surface.port';
import { fromExternal } from '../prompt-kit/message';
import { writeSystemChunk } from '../persistence/system-chunk-writer';

/**
 * `reply_route` jsonb widened LOCALLY with the seed-stamp piggyback keys (mirroring how `priority`
 * already piggybacks — see `StimulusEntity.reply_route`'s doc). The entity's declared column type stays
 * narrow; this file is the only reader/writer of the extra keys.
 */
type ReplyRouteJson = NonNullable<StimulusEntity['reply_route']> & {
  seedQuestionId?: string;
  seedSecretId?: string;
  seedFileId?: string;
};

/** A persisted event stimulus + the thread it seeded. */
export interface SeededEvent {
  stimulus: EventStimulus;
  thread: JobEntity;
  message: MessageEntity;
}

/** Raised when the unique (team, project, source, dedupe_key) index rejects a live duplicate insert. */
export class DuplicateStimulusError extends Error {
  constructor(public readonly dedupeKey: string) {
    super(`Duplicate event stimulus for dedupe_key=${dedupeKey}`);
    this.name = 'DuplicateStimulusError';
  }
}

/** Postgres unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Persistence for the intake seam — the single place stimuli/threads/messages land on the 'atlas'
 * connection. Realizes "notification-seeds-a-thread":
 *
 *  - `seedEventThread` — an `EventStimulus` OPENS a new `threads` row (origin 'event') on the
 *    routed repo, persists the originating `messages` row (the notification body)
 *    AND the `stimuli` event row. The partial-unique index on (org, repo, source,
 *    dedupe_key) is the durable backstop to the in-memory filter: a racing duplicate that slips past
 *    the window is rejected at insert (→ `DuplicateStimulusError`), so we never seed two threads for
 *    one event.
 *  - `recordChatStimulus` — a `ChatStimulus` CONTINUES its existing thread: persists the inbound
 *    `messages` row + the `stimuli` chat row (no new thread, no dedupe).
 *
 * Everything is the in-memory `Stimulus`/`Thread` currency at the seam; this store maps it to rows.
 * Zero v1 imports.
 */
@Injectable()
export class StimulusStoreService {
  private readonly logger = new Logger(StimulusStoreService.name);

  constructor(
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(MessageEntity, DB_CONNECTION)
    private readonly messages: Repository<MessageEntity>,
    @InjectRepository(StimulusEntity, DB_CONNECTION)
    private readonly stimuli: Repository<StimulusEntity>,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Open a NEW thread for a notification and persist its first message + the event stimulus row.
   * The event row's id becomes the returned `EventStimulus.id`. The unique index enforces "one live
   * event per dedupe_key" at the DB even if the in-memory filter is bypassed — a violation surfaces
   * as `DuplicateStimulusError` (the caller drops the duplicate without seeding a thread).
   */
  async seedEventThread(input: {
    orgId: string;
    repoId: string;
    source: string;
    dedupeKey: string;
    severity: EventStimulus['severity'];
    body: string;
    title: string;
  }): Promise<SeededEvent> {
    const thread = await this.jobs.save(
      this.jobs.create({
        org_id: input.orgId,
        repo_id: input.repoId,
        origin: 'event',
        kind: 'event', // notification/CI-seeded intake — first-class job kind (drives the EVENT badge + job-kind prompt)
        surface_thread_ref: null, // set when the announcement is posted (W6)
        title: input.title,
      }),
    );

    const message = await this.messages.save(
      this.messages.create({
        job_id: thread.id,
        author: input.source,
        author_id: input.source,
        author_bot_id: null,
        text: input.body,
        // Operator-visible provenance: renders as a distinct EVENT bubble (not an operator/atlas line).
        // `eventSource`/`severity` drive the bubble's header. The body stays the clean human-readable
        // text — the untrusted fence is applied only to the copy delivered to the brain.
        meta: { source: 'system_event', eventSource: input.source, severity: input.severity },
      }),
    );

    let row: StimulusEntity;
    try {
      row = await this.stimuli.save(
        this.stimuli.create({
          org_id: input.orgId,
          repo_id: input.repoId,
          kind: 'event',
          trust: 'untrusted',
          body: input.body,
          job_id: thread.id,
          author_id: null,
          reply_route: null,
          source: input.source,
          dedupe_key: input.dedupeKey,
          severity: input.severity,
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A racing duplicate beat us to the unique index — roll back the thread/message we just
        // opened so we don't leave an orphan, then signal the caller to drop it.
        await this.messages.delete({ id: message.id }).catch(() => undefined);
        await this.jobs.delete({ id: thread.id }).catch(() => undefined);
        throw new DuplicateStimulusError(input.dedupeKey);
      }
      throw err;
    }

    const stimulus: EventStimulus = {
      id: row.id,
      orgId: input.orgId,
      repoId: input.repoId,
      kind: 'event',
      trust: 'untrusted',
      jobId: thread.id,
      body: input.body,
      source: input.source,
      dedupeKey: input.dedupeKey,
      severity: input.severity,
      receivedAt: row.created_at,
    };
    return { stimulus, thread, message };
  }

  /**
   * Attach an event to an EXISTING job (its brain) instead of seeding a new thread — the return-path
   * for a GitHub event on a PR/branch Atlas already owns (CI failure, merge conflict, review comment).
   * Mirrors {@link seedEventThread} (message row with `system_event` provenance + a `kind:'event'`
   * stimulus row) but reuses the given `jobId`, so the same at-least-once boot sweep + `delivered_at`
   * machinery drives delivery. Dedup rides the SAME (org, repo, source, dedupe_key) unique index — a
   * repeated conflict/CI/review event collapses to one delivered message.
   */
  async attachEventToJob(input: {
    jobId: string;
    orgId: string;
    repoId: string;
    source: string;
    dedupeKey: string;
    severity: EventStimulus['severity'];
    body: string;
    /** Optional render-only card payload persisted on the message row. */
    card?: Record<string, unknown>;
  }): Promise<EventStimulus> {
    // ATOMIC: the operator-visible `system_event` card and the `stimuli` row that DRIVES brain delivery must
    // commit together. Two separate saves let a crash between them leave a visible event card with NO stimulus
    // row — which the at-least-once sweep (keyed on `stimuli.delivered_at`) can never recover, so the card
    // would render forever with the brain never consuming it. One transaction makes it both-or-neither.
    let row: StimulusEntity;
    try {
      row = await this.dataSource.transaction(async (m) => {
        await m.save(
          m.create(MessageEntity, {
            job_id: input.jobId,
            author: input.source,
            author_id: input.source,
            author_bot_id: null,
            text: input.body,
            card: input.card ?? null,
            meta: { source: 'system_event', eventSource: input.source, severity: input.severity },
          }),
        );
        return m.save(
          m.create(StimulusEntity, {
            org_id: input.orgId,
            repo_id: input.repoId,
            kind: 'event',
            trust: 'untrusted',
            body: input.body,
            job_id: input.jobId,
            author_id: null,
            reply_route: null,
            source: input.source,
            dedupe_key: input.dedupeKey,
            severity: input.severity,
          }),
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A duplicate of this exact event was already recorded for the job. The transaction rolled back BOTH
        // the card and the stimulus row, so there is nothing to clean up — just signal skip re-delivery.
        throw new DuplicateStimulusError(input.dedupeKey);
      }
      throw err;
    }

    return {
      id: row.id,
      orgId: input.orgId,
      repoId: input.repoId,
      kind: 'event',
      trust: 'untrusted',
      jobId: input.jobId,
      body: input.body,
      source: input.source,
      dedupeKey: input.dedupeKey,
      severity: input.severity,
      receivedAt: row.created_at,
    };
  }

  /**
   * Find the OPEN job that owns a branch in a repo — the correlation key for routing a GitHub event
   * back to Atlas. Matches either the canonical {@link JobEntity.feature_branch} (frozen once a PR
   * exists) or the observed {@link JobEntity.current_branch} (pre-PR, sampled from sandbox HEAD).
   * Newest first; null if none. Closed jobs are excluded so a stale merged branch never re-wakes.
   */
  async findOwningJobByBranch(
    orgId: string,
    repoId: string,
    branch: string,
  ): Promise<JobEntity | null> {
    return this.jobs
      .createQueryBuilder('j')
      .where('j.org_id = :orgId', { orgId })
      .andWhere('j.repo_id = :repoId', { repoId })
      .andWhere('(j.feature_branch = :branch OR j.current_branch = :branch)', { branch })
      .andWhere('j.status != :closed', { closed: 'closed' })
      .orderBy('j.created_at', 'DESC')
      .getOne();
  }

  /** Find the job that owns a PR number in a repo (for review/PR events). Newest first; null if none. */
  async findOwningJobByPrNumber(
    orgId: string,
    repoId: string,
    prNumber: number,
  ): Promise<JobEntity | null> {
    return this.jobs
      .createQueryBuilder('j')
      .where('j.org_id = :orgId', { orgId })
      .andWhere('j.repo_id = :repoId', { repoId })
      .andWhere('j.pr_number = :prNumber', { prNumber })
      .orderBy('j.created_at', 'DESC')
      .getOne();
  }

  /**
   * Persist a chat message continuing an existing thread + its chat stimulus row. Returns the
   * `ChatStimulus` with its minted id. No new thread, no dedupe (chat bypasses the filter).
   */
  async recordChatStimulus(input: {
    orgId: string;
    repoId: string;
    jobId: string;
    author: { id: string; displayName: string };
    replyRoute: { surfaceId: string; jobRef: string };
    body: string;
    /** Optional render-only card payload (e.g. a review-comments batch) carried on the persisted row. */
    card?: Record<string, unknown>;
    /** Delivery priority (d18: `now` | `queue` | `later`); absent = `now`. Piggybacked into `reply_route` jsonb. */
    priority?: 'now' | 'queue' | 'later';
    /**
     * SEED RENDER COMMAND (see `SeedRow`) — when present, this is a system seed: a descriptor writes a
     * deduped curated pill INSTEAD of the plain operator `messages` bubble; `'skip'` writes NEITHER (the
     * content already has a durable row elsewhere). Absent = a normal operator chat message (today's
     * behavior — the plain bubble is written).
     */
    systemChunk?: SeedRow;
    /** DELIVERY SEED — piggybacked into `reply_route` jsonb (see `ChatStimulus.seedQuestionId`). */
    seedQuestionId?: string;
    /** DELIVERY SEED (secret variant) — piggybacked into `reply_route` jsonb (see `ChatStimulus.seedSecretId`). */
    seedSecretId?: string;
    /** DELIVERY SEED (file variant) — piggybacked into `reply_route` jsonb (see `ChatStimulus.seedFileId`). */
    seedFileId?: string;
  }): Promise<ChatStimulus> {
    // ATOMIC: the operator-visible row (a plain bubble, a curated pill, or nothing) and the `stimuli` row
    // that DRIVES the brain turn must commit together. Two separate saves let a crash between them (e.g. a
    // mid-turn process restart) leave a transcript row with no stimulus behind it — it renders but no turn
    // ever runs and the durable delivery pump can't recover a row that was never written. One transaction
    // makes it both-or-neither.
    const replyRoute: ReplyRouteJson = {
      ...input.replyRoute,
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.seedQuestionId ? { seedQuestionId: input.seedQuestionId } : {}),
      ...(input.seedSecretId ? { seedSecretId: input.seedSecretId } : {}),
      ...(input.seedFileId ? { seedFileId: input.seedFileId } : {}),
    };

    const row = await this.dataSource.transaction(async (m) => {
      if (input.systemChunk === undefined) {
        await m.save(
          m.create(MessageEntity, {
            job_id: input.jobId,
            author: input.author.displayName,
            author_id: input.author.id,
            author_bot_id: null,
            text: input.body,
            card: input.card ?? null,
          }),
        );
      } else if (input.systemChunk !== 'skip') {
        const desc = input.systemChunk;
        // Reveal-on-expand raw payload — mirror `persistSeedRow`: carry the full engine body only when it's
        // trusted and actually differs from the short curated label (an untrusted row's label already IS the
        // clean fenced report, with the trusted framing in its own block).
        const isUntrusted = (desc.kind ?? 'system_notice') === 'untrusted';
        const fullBody =
          !isUntrusted && input.body !== desc.label ? input.body : undefined;
        await writeSystemChunk(m.getRepository(MessageEntity), {
          jobId: input.jobId,
          kind: desc.kind ?? 'system_notice',
          text: fromExternal(desc.label),
          chunkKey: desc.chunkKey,
          ...(desc.untrustedSource ? { untrustedSource: desc.untrustedSource } : {}),
          ...(desc.severity ? { severity: desc.severity } : {}),
          ...(fullBody ? { fullBody: fromExternal(fullBody) } : {}),
          ...(desc.framing ? { framing: desc.framing } : {}),
        });
      }
      // else 'skip': neither the plain bubble nor a pill — the content already has a durable row elsewhere.

      return m.save(
        m.create(StimulusEntity, {
          org_id: input.orgId,
          repo_id: input.repoId,
          kind: 'chat',
          trust: 'trusted',
          body: input.body,
          job_id: input.jobId,
          author_id: input.author.id,
          author_name: input.author.displayName,
          reply_route: replyRoute,
          source: null,
          dedupe_key: null,
          severity: null,
        }),
      );
    });

    return {
      id: row.id,
      orgId: input.orgId,
      repoId: input.repoId,
      kind: 'chat',
      trust: 'trusted',
      body: input.body,
      jobId: input.jobId,
      author: input.author,
      replyRoute: input.replyRoute,
      receivedAt: row.created_at,
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.seedQuestionId ? { seedQuestionId: input.seedQuestionId } : {}),
      ...(input.seedSecretId ? { seedSecretId: input.seedSecretId } : {}),
      ...(input.seedFileId ? { seedFileId: input.seedFileId } : {}),
      ...(input.author.id === SYSTEM_SEED_AUTHOR.id ? { seed: true } : {}),
    };
  }

  // ── Durable operator-message delivery: the chat-inbox queries ─────────────────────────────────────
  //
  // These back the brain's durable-delivery pump (AgentSessionManager). They live here — not inline on
  // the manager — so the query logic is independently unit/integration-testable without the manager's
  // full constructor. Chat rows ARE the durable operator-message inbox; see StimulusEntity.{delivered_at,
  // attempted_at}.

  /** A thread's eligible pending chat stimuli (undelivered + lease-free), oldest first, as ChatStimulus. */
  async eligiblePendingChat(jobId: string, leaseMs: number): Promise<ChatStimulus[]> {
    const cutoff = new Date(Date.now() - leaseMs);
    const rows = await this.stimuli
      .createQueryBuilder('s')
      .where('s.kind = :k', { k: 'chat' })
      .andWhere('s.job_id = :j', { j: jobId })
      .andWhere('s.delivered_at IS NULL')
      .andWhere('(s.attempted_at IS NULL OR s.attempted_at < :cutoff)', { cutoff })
      .orderBy('s.created_at', 'ASC')
      .getMany();
    return rows.map((r) => this.rowToChatStimulus(r));
  }

  /** Stamp the delivery lease (`attempted_at = now`) so a concurrent sweep can't re-take these rows. */
  async leaseChatStimuli(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.stimuli.update({ id: In(ids) }, { attempted_at: new Date() });
  }

  /** Mark a chat stimulus delivered (idempotent — only stamps a still-null row). */
  async markChatDelivered(id: string): Promise<void> {
    await this.stimuli.update({ id, delivered_at: IsNull() }, { delivered_at: new Date() });
  }

  /** Reconstruct a single chat stimulus by id (the durable stimuli.id), or null. Used by the brain to
   *  resolve a delivered row's seed stamp targets (seedQuestionId/seedSecretId/seedFileId) from reply_route. */
  async findChatStimulusById(id: string): Promise<ChatStimulus | null> {
    const row = await this.stimuli.findOne({ where: { id, kind: 'chat' } });
    return row ? this.rowToChatStimulus(row) : null;
  }

  /** Distinct (thread, org, repo) tuples with at least one undelivered chat stimulus — the sweep worklist. */
  async undeliveredChatThreads(): Promise<Array<{ jobId: string; orgId: string; repoId: string }>> {
    const rows = await this.stimuli
      .createQueryBuilder('s')
      .select('s.job_id', 'job_id')
      .addSelect('s.org_id', 'org_id')
      .addSelect('s.repo_id', 'repo_id')
      .distinct(true)
      .where('s.kind = :k', { k: 'chat' })
      .andWhere('s.delivered_at IS NULL')
      .andWhere('s.job_id IS NOT NULL')
      // A thread whose ONLY undelivered rows are `later` must not be swept awake — `later` only rides
      // along a turn that runs for some other reason (d18).
      .andWhere("(s.reply_route ->> 'priority' IS NULL OR s.reply_route ->> 'priority' != 'later')")
      .getRawMany<{ job_id: string; org_id: string; repo_id: string }>();
    return rows.map((r) => ({ jobId: r.job_id, orgId: r.org_id, repoId: r.repo_id }));
  }

  /** Clear the lease on every undelivered chat row (boot reconcile — re-drive anything mid-attempt at crash). */
  async resetChatLeases(): Promise<void> {
    await this.stimuli.update(
      { kind: 'chat', delivered_at: IsNull() },
      { attempted_at: null },
    );
  }

  // ── Durable EVENT delivery: the event-inbox queries (mirror the chat inbox above) ──────────────────
  //
  // Routed GitHub events are `kind:'event'` `stimuli` rows; `delivered_at` is the same at-least-once ledger
  // as chat. Unlike chat these aren't coalesced per-thread — each event is one delivery unit — so the sweep
  // worklist is the events themselves (leader-wide), not distinct threads. `leaseChatStimuli`/
  // `markChatDelivered` are by-id (kind-agnostic) and reused for event rows.

  /** Every eligible pending event (undelivered + lease-free), oldest first, as EventStimulus — the sweep worklist. */
  async eligiblePendingEvents(leaseMs: number): Promise<EventStimulus[]> {
    const cutoff = new Date(Date.now() - leaseMs);
    const rows = await this.stimuli
      .createQueryBuilder('s')
      .where('s.kind = :k', { k: 'event' })
      .andWhere('s.delivered_at IS NULL')
      .andWhere('s.job_id IS NOT NULL')
      .andWhere('(s.attempted_at IS NULL OR s.attempted_at < :cutoff)', { cutoff })
      .orderBy('s.created_at', 'ASC')
      .getMany();
    return rows.map((r) => this.rowToEventStimulus(r));
  }

  /** Clear the lease on every undelivered event row (boot reconcile — re-drive anything mid-attempt at crash). */
  async resetEventLeases(): Promise<void> {
    await this.stimuli.update(
      { kind: 'event', delivered_at: IsNull() },
      { attempted_at: null },
    );
  }

  /** Reconstruct the in-memory `EventStimulus` from a persisted event row (for re-drive). Body is the CLEAN
   *  text — the untrusted fence is re-applied at the delivery seam (`renderEventDelivery`). */
  private rowToEventStimulus(row: StimulusEntity): EventStimulus {
    return {
      id: row.id,
      orgId: row.org_id,
      repoId: row.repo_id,
      kind: 'event',
      trust: 'untrusted',
      jobId: row.job_id as string,
      body: row.body,
      source: row.source ?? 'webhook',
      dedupeKey: row.dedupe_key ?? '',
      severity: (row.severity as EventStimulus['severity'] | null) ?? 'info',
      receivedAt: row.created_at,
    };
  }

  /** Reconstruct the in-memory `ChatStimulus` from a persisted chat row (for re-drive). */
  private rowToChatStimulus(row: StimulusEntity): ChatStimulus {
    const replyRoute: ReplyRouteJson | null = row.reply_route;
    return {
      id: row.id,
      orgId: row.org_id,
      repoId: row.repo_id,
      kind: 'chat',
      trust: 'trusted',
      body: row.body,
      jobId: row.job_id as string,
      author: {
        id: row.author_id ?? '',
        // Rows written before author_name existed fall back to the scope id as the display label.
        displayName: row.author_name ?? row.author_id ?? 'operator',
      },
      replyRoute: row.reply_route ?? { surfaceId: '', jobRef: row.job_id as string },
      receivedAt: row.created_at,
      ...(replyRoute?.priority ? { priority: replyRoute.priority } : {}),
      ...(replyRoute?.seedQuestionId ? { seedQuestionId: replyRoute.seedQuestionId } : {}),
      ...(replyRoute?.seedSecretId ? { seedSecretId: replyRoute.seedSecretId } : {}),
      ...(replyRoute?.seedFileId ? { seedFileId: replyRoute.seedFileId } : {}),
      ...(row.author_id === SYSTEM_SEED_AUTHOR.id ? { seed: true } : {}),
    };
  }

}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}
