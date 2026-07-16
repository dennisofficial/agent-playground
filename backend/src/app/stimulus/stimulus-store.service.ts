import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, QueryFailedError, Repository } from 'typeorm';
import type {
  EventKind,
  EventMessage,
  EventSeverity,
  Message,
  MessageType,
  SeedRow,
  TurnEnvelope,
} from '@shared/domain';
import { JobBootstrapService } from '../job-bootstrap';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  TranscriptMessageEntity,
  InboundMessageEntity,
  JobEntity,
} from '../persistence/entities';
import { SYSTEM_SEED_AUTHOR } from '../surface/chat-surface.port';
import { fromExternal } from '@shared/prompt-kit/message';
import { writeSystemChunk } from '../persistence/system-chunk-writer';
import {
  chunkKey,
  renderBornBlockedProvenanceNote,
  renderMidFlightBlockedNote,
} from '../prompt-kit/harness';
import type { JobProvenance } from '@shared/domain/job';

/**
 * `reply_route` jsonb widened LOCALLY with the seed-stamp piggyback keys (mirroring how `priority`
 * already piggybacks — see `StimulusEntity.reply_route`'s doc). The entity's declared column type stays
 * narrow; this file is the only reader/writer of the extra keys.
 */
type ReplyRouteJson = NonNullable<InboundMessageEntity['reply_route']> & {
  seedQuestionId?: string;
  seedSecretId?: string;
  seedFileId?: string;
  /** BATCH delivery: arrays of card ids a single combined `answer-batch` seed stamps on its success
   *  tail (plural of the singular `seed*Id` keys — same jsonb piggyback, no schema change). */
  seedQuestionIds?: string[];
  seedSecretIds?: string[];
  seedFileIds?: string[];
  /** Block/unblock DEDUPE stamps — mark a queued born-blocked provenance note, mid-flight "blocked" note,
   *  or unblock note so `hasChatStimulusForSeedTarget` can find the one pending row and never stack a second
   *  (same jsonb piggyback as the `seed*Id` keys — no schema change). */
  bornBlockedSeed?: boolean;
  blockNote?: boolean;
  unblockNote?: boolean;
};

/** Raised when the unique (team, project, source, dedupe_key) index rejects a live duplicate insert. */
export class DuplicateStimulusError extends Error {
  constructor(public readonly dedupeKey: string) {
    super(`Duplicate event stimulus for dedupe_key=${dedupeKey}`);
    this.name = 'DuplicateStimulusError';
  }
}

/** Postgres unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505';

/** The System scope a build-lane HOST SEED is authored by — never an operator (matches the `U-SYSTEM`/`System`
 *  convention used for host-authored rows elsewhere). Kept local to avoid a stimulus→surface import edge. */
const HOST_SEED_AUTHOR = { id: 'U-SYSTEM', displayName: 'System' } as const;

/**
 * Persistence for the intake seam — the single place stimuli/threads/messages land on the 'atlas'
 * connection.
 *
 *  - `attachEventToJob` — an `EventMessage` is delivered to the brain of the job that already OWNS its
 *    PR/branch: persists the operator-visible `messages` row + the `stimuli` event row atomically. The
 *    partial-unique index on (org, repo, source, dedupe_key) is the durable backstop to the in-memory
 *    filter: a racing duplicate that slips past the window is rejected at insert (→ `DuplicateStimulusError`),
 *    so one event collapses to one delivered message.
 *  - `recordChatStimulus` — a chat/seed `Message` CONTINUES its existing thread: persists the inbound
 *    `messages` row + the `stimuli` chat row (no new thread, no dedupe), returning a `TurnEnvelope`.
 *
 * The brain's turn currency is the `TurnEnvelope` (wrapping a typed `Message`); this store maps it to/from
 * rows. Zero v1 imports.
 */
@Injectable()
export class StimulusStoreService {
  private readonly logger = new Logger(StimulusStoreService.name);

  constructor(
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(TranscriptMessageEntity, DB_CONNECTION)
    private readonly messages: Repository<TranscriptMessageEntity>,
    @InjectRepository(InboundMessageEntity, DB_CONNECTION)
    private readonly stimuli: Repository<InboundMessageEntity>,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
    // Bootstraps a freshly-seeded thread's ONE planning thread group + thread (d7: `thread_group_id` is never null).
    // @Optional (trailing) so the existing direct-construction unit tests (positional args) keep compiling
    // without a trailing argument.
    @Optional() private readonly jobBootstrap?: JobBootstrapService,
  ) {}

  /** The job's planning thread group thread id — the anchor a job-level message row is stamped onto
   *  (`messages.thread_id` is NOT NULL). Wired in prod via DI; throws loudly if absent at use. */
  private async planningThreadId(jobId: string): Promise<string> {
    if (!this.jobBootstrap)
      throw new Error('stimulus-store: JobBootstrapService not wired');
    return this.jobBootstrap.planningThreadId(jobId);
  }

  /**
   * Attach an event to an EXISTING job (its brain) — the return-path for a GitHub event on a PR/branch
   * Atlas already owns (CI failure, merge conflict, review comment). Persists a `messages` row with
   * `system_event` provenance + a `kind:'event'` stimulus row against the given `jobId`, so the same
   * at-least-once boot sweep + `delivered_at` machinery drives delivery. Dedup rides the SAME (org, repo,
   * source, dedupe_key) unique index — a
   * repeated conflict/CI/review event collapses to one delivered message.
   *
   * ROUTING (thread 4 §CI-routing): once the job's `ci` thread group thread exists (post-ship —
   * `DriverStoreService.ensureCiThread`), the event's `messages` row AND its `stimuli.lane` both target
   * that thread (`thread:<ciThreadId>`) instead of planning, so `EventMessage.resumeThreadId` (derived
   * back from `lane` on read — see `rowToEventMessage`) resumes the `ci` thread's own session. Pre-ship
   * (no `ci` thread yet) falls back to planning exactly as before.
   */
  async attachEventToJob(input: {
    jobId: string;
    orgId: string;
    repoId: string;
    source: string;
    dedupeKey: string;
    severity: EventSeverity;
    /** Render-time discriminant threaded from ingress onto the transcript row's `meta` (never persisted
     *  on the event row). */
    eventKind: EventKind;
    body: string;
    /** Optional render-only card payload persisted on the message row. */
    card?: Record<string, unknown>;
  }): Promise<EventMessage> {
    // ATOMIC: the operator-visible `system_event` card and the `stimuli` row that DRIVES brain delivery must
    // commit together. Two separate saves let a crash between them leave a visible event card with NO stimulus
    // row — which the at-least-once sweep (keyed on `stimuli.delivered_at`) can never recover, so the card
    // would render forever with the brain never consuming it. One transaction makes it both-or-neither.
    await this.jobBootstrap?.ensurePlanningThreadGroup(input.jobId, input.orgId);
    const ciThreadId =
      (await this.jobBootstrap?.ciThreadId(input.jobId)) ?? null;
    const threadId = ciThreadId ?? (await this.planningThreadId(input.jobId));
    const lane = ciThreadId ? `thread:${ciThreadId}` : undefined;
    let row: InboundMessageEntity;
    try {
      row = await this.dataSource.transaction(async (m) => {
        await m.save(
          m.create(TranscriptMessageEntity, {
            job_id: input.jobId,
            thread_id: threadId,
            author: input.source,
            author_id: input.source,
            author_bot_id: null,
            text: input.body,
            card: input.card ?? null,
            meta: {
              source: 'system_event',
              eventSource: input.source,
              severity: input.severity,
              eventKind: input.eventKind,
            },
          }),
        );
        return m.save(
          m.create(InboundMessageEntity, {
            org_id: input.orgId,
            repo_id: input.repoId,
            kind: 'event',
            type: 'event',
            trust: 'untrusted',
            body: input.body,
            job_id: input.jobId,
            author_id: null,
            reply_route: null,
            source: input.source,
            dedupe_key: input.dedupeKey,
            severity: input.severity,
            ...(lane ? { lane } : {}),
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
      type: 'event',
      trust: 'untrusted',
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      body: input.body,
      source: input.source,
      eventKind: input.eventKind,
      dedupeKey: input.dedupeKey,
      severity: input.severity,
      receivedAt: row.created_at.toISOString(),
      ...(ciThreadId ? { resumeThreadId: ciThreadId } : {}),
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
      .andWhere('(j.feature_branch = :branch OR j.current_branch = :branch)', {
        branch,
      })
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
   * Persist a chat/seed message continuing an existing thread + its inbound row. Returns the
   * `TurnEnvelope` with its minted id. No new thread, no dedupe (chat bypasses the filter).
   */
  async recordChatStimulus(input: {
    orgId: string;
    repoId: string;
    jobId: string;
    author: { id: string; displayName: string };
    replyRoute: { surfaceId: string; jobRef: string };
    body: string;
    /**
     * The `Message`-union discriminant persisted on the `type` column. Explicit callers (the intake seam)
     * pass it; the brain-side direct callers omit it, so it's inferred from the seed-author signal below.
     */
    type?: MessageType;
    /** Optional render-only card payload (e.g. a review-comments batch) carried on the persisted row. */
    card?: Record<string, unknown>;
    /** Delivery priority (d18: `now` | `queue` | `later`); absent = `now`. Piggybacked into `reply_route` jsonb. */
    priority?: 'now' | 'queue' | 'later';
    /** The routing coordinate (`'main'` | `'thread:<threadId>'`); absent = `'main'`. Brain callers omit it,
     *  so their rows are byte-identical to before this field existed. */
    lane?: string;
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
    /** BATCH DELIVERY SEED — arrays of card ids a single combined seed stamps (see `ChatStimulus.seedQuestionIds`). */
    seedQuestionIds?: string[];
    seedSecretIds?: string[];
    seedFileIds?: string[];
    /** BLOCK/UNBLOCK DEDUPE stamps — piggybacked into `reply_route` jsonb so `hasChatStimulusForSeedTarget`
     *  can locate the one pending born-blocked provenance note / mid-flight "blocked" note / unblock note. */
    bornBlockedSeed?: boolean;
    blockNote?: boolean;
    unblockNote?: boolean;
  }): Promise<TurnEnvelope> {
    // ATOMIC: the operator-visible row (a plain bubble, a curated pill, or nothing) and the `stimuli` row
    // that DRIVES the brain turn must commit together. Two separate saves let a crash between them (e.g. a
    // mid-turn process restart) leave a transcript row with no stimulus behind it — it renders but no turn
    // ever runs and the durable delivery pump can't recover a row that was never written. One transaction
    // makes it both-or-neither.
    // `'seed'` is retired from the `Message` union but is still a valid persisted `type` string for the
    // legacy brain-side direct callers (mirrors `recordHostSeed`'s raw `'seed'` write); the intake seam now
    // passes an explicit `input.type` and never falls through to it.
    const type: MessageType | 'seed' =
      input.type ??
      (input.author.id === SYSTEM_SEED_AUTHOR.id ? 'seed' : 'user');

    const replyRoute: ReplyRouteJson = {
      ...input.replyRoute,
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.seedQuestionId ? { seedQuestionId: input.seedQuestionId } : {}),
      ...(input.seedSecretId ? { seedSecretId: input.seedSecretId } : {}),
      ...(input.seedFileId ? { seedFileId: input.seedFileId } : {}),
      ...(input.seedQuestionIds?.length
        ? { seedQuestionIds: input.seedQuestionIds }
        : {}),
      ...(input.seedSecretIds?.length
        ? { seedSecretIds: input.seedSecretIds }
        : {}),
      ...(input.seedFileIds?.length ? { seedFileIds: input.seedFileIds } : {}),
      ...(input.bornBlockedSeed ? { bornBlockedSeed: input.bornBlockedSeed } : {}),
      ...(input.blockNote ? { blockNote: input.blockNote } : {}),
      ...(input.unblockNote ? { unblockNote: input.unblockNote } : {}),
    };

    // `lane` is the routing coordinate (`'main'` | `'thread:<threadId>'`) — a thread-lane message lands on
    // that thread, everything else (including the brain's default `'main'`) on the job's planning thread.
    if (!input.lane?.startsWith('thread:')) {
      await this.jobBootstrap?.ensurePlanningThreadGroup(input.jobId, input.orgId);
    }
    const threadId = input.lane?.startsWith('thread:')
      ? input.lane.slice('thread:'.length)
      : await this.planningThreadId(input.jobId);

    const row = await this.dataSource.transaction(async (m) => {
      if (input.systemChunk === undefined) {
        await m.save(
          m.create(TranscriptMessageEntity, {
            job_id: input.jobId,
            thread_id: threadId,
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
        await writeSystemChunk(m.getRepository(TranscriptMessageEntity), {
          jobId: input.jobId,
          threadId,
          kind: desc.kind ?? 'system_notice',
          text: fromExternal(desc.label),
          chunkKey: desc.chunkKey,
          ...(desc.untrustedSource
            ? { untrustedSource: desc.untrustedSource }
            : {}),
          ...(desc.severity ? { severity: desc.severity } : {}),
          ...(fullBody ? { fullBody: fromExternal(fullBody) } : {}),
          ...(desc.framing ? { framing: desc.framing } : {}),
          // Frontend per-seed-type pill discriminant (mirrors `meta.eventKind`); only for a genuine typed
          // internal-seed row, never a plain operator `'user'` turn or a type-less legacy seed.
          ...(input.type && input.type !== 'user'
            ? { seedType: input.type }
            : {}),
        });
      }
      // else 'skip': neither the plain bubble nor a pill — the content already has a durable row elsewhere.

      return m.save(
        m.create(InboundMessageEntity, {
          org_id: input.orgId,
          repo_id: input.repoId,
          kind: 'chat',
          type,
          trust: 'trusted',
          body: input.body,
          job_id: input.jobId,
          author_id: input.author.id,
          author_name: input.author.displayName,
          reply_route: replyRoute,
          source: null,
          dedupe_key: null,
          severity: null,
          ...(input.lane ? { lane: input.lane } : {}),
        }),
      );
    });

    const resumeThreadId = resumeThreadIdFromLane(input.lane);
    const deliveredQuestionIds = collapseDeliveredIds(
      input.seedQuestionId,
      input.seedQuestionIds,
    );
    const deliveredSecretIds = collapseDeliveredIds(
      input.seedSecretId,
      input.seedSecretIds,
    );
    const deliveredFileIds = collapseDeliveredIds(
      input.seedFileId,
      input.seedFileIds,
    );
    return {
      message: reconstructMessage({
        id: row.id,
        orgId: input.orgId,
        repoId: input.repoId,
        jobId: input.jobId,
        receivedAt: row.created_at,
        type,
      }),
      id: row.id,
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      receivedAt: row.created_at,
      author: input.author,
      replyRoute: input.replyRoute,
      body: input.body,
      ...(input.priority ? { priority: input.priority } : {}),
      ...(deliveredQuestionIds ? { deliveredQuestionIds } : {}),
      ...(deliveredSecretIds ? { deliveredSecretIds } : {}),
      ...(deliveredFileIds ? { deliveredFileIds } : {}),
      ...(input.card ? { card: input.card } : {}),
      ...(resumeThreadId ? { resumeThreadId } : {}),
    };
  }

  /**
   * BORN-BLOCKED: record the creation-time provenance note + the opening brief as TWO undelivered
   * `main`-lane chat stimuli (author System), recorded ONCE — a re-driven block edge finds the pending
   * provenance row and no-ops. Held, never enqueued: the `isJobBlocked` guard would hold them anyway, and
   * the wake funnel's pump coalesces them with the JIT unblock note into ONE timestamped turn. Oldest-first
   * (provenance, then brief) so the drained turn reads in order. The provenance note gets a curated pill; the
   * brief is a plain System bubble carrying the operator's opening body verbatim.
   */
  async recordBornBlockedSeedsIfAbsent(input: {
    orgId: string;
    repoId: string;
    jobId: string;
    brief: string;
    createdBy: JobProvenance | null;
  }): Promise<void> {
    if (
      await this.hasChatStimulusForSeedTarget(input.jobId, {
        bornBlockedSeed: true,
      })
    ) {
      return;
    }
    const author = {
      id: SYSTEM_SEED_AUTHOR.id,
      displayName: SYSTEM_SEED_AUTHOR.name,
    };
    const replyRoute = { surfaceId: 'web', jobRef: input.jobId };
    await this.recordChatStimulus({
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      author,
      replyRoute,
      type: 'follow_up_job_seed',
      body: renderBornBlockedProvenanceNote(input.createdBy),
      lane: 'main',
      bornBlockedSeed: true,
      systemChunk: {
        label: 'Queued — starts when unblocked',
        chunkKey: chunkKey.bornBlockedSeed(input.jobId),
      },
    });
    await this.recordChatStimulus({
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      author,
      replyRoute,
      type: 'follow_up_job_seed',
      body: input.brief,
      lane: 'main',
    });
  }

  /**
   * MID-FLIGHT block: record ONE undelivered `main`-lane "you've been blocked" note (author System),
   * recorded ONCE. Held for the wake funnel's pump to coalesce with the JIT unblock note.
   */
  async recordBlockedNoteIfAbsent(input: {
    orgId: string;
    repoId: string;
    jobId: string;
  }): Promise<void> {
    if (
      await this.hasChatStimulusForSeedTarget(input.jobId, { blockNote: true })
    ) {
      return;
    }
    await this.recordChatStimulus({
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      author: {
        id: SYSTEM_SEED_AUTHOR.id,
        displayName: SYSTEM_SEED_AUTHOR.name,
      },
      replyRoute: { surfaceId: 'web', jobRef: input.jobId },
      body: renderMidFlightBlockedNote(),
      lane: 'main',
      blockNote: true,
      systemChunk: {
        label: 'Blocked',
        chunkKey: chunkKey.blockNote(input.jobId),
      },
    });
  }

  /**
   * The blocked-overlay preview body for ONE job (the DTO source that replaced `jobs.blocked_seed_message`):
   * the pending born-blocked BRIEF body when the job was created blocked, or the "blocked" note body when it
   * was blocked mid-flight; null when neither is queued. Read only while the job is `blocked` (the caller
   * gates on status).
   */
  async pendingBlockedPreview(jobId: string): Promise<string | null> {
    const rows = await this.pendingBlockedRows([jobId]);
    return pickBlockedPreview(rows);
  }

  /**
   * Batched {@link pendingBlockedPreview} for the list DTOs — one query for many jobs (models on
   * `JobDependencyService.blockersOfManyBlocked` to avoid N+1). Returns jobId → its preview (or null).
   */
  async pendingLockedPreviews(
    jobIds: string[],
  ): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    if (jobIds.length === 0) return map;
    const rows = await this.pendingBlockedRows(jobIds);
    const byJob = new Map<string, InboundMessageEntity[]>();
    for (const r of rows) {
      const list = byJob.get(r.job_id as string) ?? [];
      list.push(r);
      byJob.set(r.job_id as string, list);
    }
    for (const jobId of jobIds) {
      map.set(jobId, pickBlockedPreview(byJob.get(jobId) ?? []));
    }
    return map;
  }

  /** The undelivered `main`-lane chat stimuli for the given jobs, oldest-first — the raw rows both preview
   *  lookups pick the born-blocked brief / mid-flight note out of. */
  private async pendingBlockedRows(
    jobIds: string[],
  ): Promise<InboundMessageEntity[]> {
    return this.stimuli
      .createQueryBuilder('s')
      .where('s.kind = :k', { k: 'chat' })
      .andWhere('s.job_id IN (:...ids)', { ids: jobIds })
      .andWhere('s.delivered_at IS NULL')
      .andWhere("COALESCE(s.lane, 'main') = 'main'")
      .orderBy('s.created_at', 'ASC')
      .getMany();
  }

  /**
   * Persist a HOST SEED continuing a build lane — the durable `stimuli` row ONLY, no operator `messages`
   * bubble. Unlike {@link recordChatStimulus} (which atomically writes an operator-visible bubble + the
   * stimulus, so a build-lane seed would render as a main-thread OPERATOR message — wrong: build lanes are
   * operator-read-only), this writes just the delivery-ledger row so the at-least-once pump still drives it,
   * authored by the System scope (never an operator). The VISIBLE read-only build-lane row is emitted
   * separately by the caller via `recordBuildSystemChunk`. `priority` is piggybacked into `reply_route`
   * exactly as {@link recordChatStimulus} does; `lane` is the build lane (`thread:<threadId>`).
   */
  async recordHostSeed(input: {
    orgId: string;
    repoId: string;
    jobId: string;
    lane: string;
    body: string;
    priority?: 'now' | 'queue' | 'later';
  }): Promise<TurnEnvelope> {
    const replyRoute = { surfaceId: 'web', jobRef: input.jobId };
    const row = await this.stimuli.save(
      this.stimuli.create({
        org_id: input.orgId,
        repo_id: input.repoId,
        kind: 'chat',
        type: 'seed',
        trust: 'trusted',
        body: input.body,
        job_id: input.jobId,
        author_id: HOST_SEED_AUTHOR.id,
        author_name: HOST_SEED_AUTHOR.displayName,
        reply_route: input.priority
          ? { ...replyRoute, priority: input.priority }
          : replyRoute,
        source: null,
        dedupe_key: null,
        severity: null,
        lane: input.lane,
      }),
    );

    const author = {
      id: HOST_SEED_AUTHOR.id,
      displayName: HOST_SEED_AUTHOR.displayName,
    };
    return {
      message: reconstructMessage({
        id: row.id,
        orgId: input.orgId,
        repoId: input.repoId,
        jobId: input.jobId,
        receivedAt: row.created_at,
        type: 'seed',
      }),
      id: row.id,
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      receivedAt: row.created_at,
      author,
      replyRoute,
      body: input.body,
      ...(input.priority ? { priority: input.priority } : {}),
    };
  }

  // ── Durable operator-message delivery: the chat-inbox queries ─────────────────────────────────────
  //
  // These back the brain's durable-delivery pump (AgentSessionManager). They live here — not inline on
  // the manager — so the query logic is independently unit/integration-testable without the manager's
  // full constructor. Chat rows ARE the durable operator-message inbox; see StimulusEntity.{delivered_at,
  // attempted_at}.

  /**
   * A lane's eligible pending chat stimuli (undelivered + lease-free), oldest first, as TurnEnvelope.
   * `lane` is a trailing optional param defaulting `'main'` so every existing (jobId, leaseMs) brain
   * caller keeps working unchanged; a build-lane caller passes its `'thread:<id>'` lane explicitly.
   * Legacy NULL `lane` rows (written before this column existed) are treated as `'main'`.
   */
  async eligiblePendingChat(
    jobId: string,
    leaseMs: number,
    lane: string = 'main',
  ): Promise<TurnEnvelope[]> {
    const cutoff = new Date(Date.now() - leaseMs);
    const rows = await this.stimuli
      .createQueryBuilder('s')
      .where('s.kind = :k', { k: 'chat' })
      .andWhere('s.job_id = :j', { j: jobId })
      .andWhere("COALESCE(s.lane, 'main') = :lane", { lane })
      .andWhere('s.delivered_at IS NULL')
      .andWhere('(s.attempted_at IS NULL OR s.attempted_at < :cutoff)', {
        cutoff,
      })
      .orderBy('s.created_at', 'ASC')
      .getMany();
    return rows.map((r) => this.rowToEnvelope(r));
  }

  /** Stamp the delivery lease (`attempted_at = now`) so a concurrent sweep can't re-take these rows. */
  async leaseChatStimuli(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.stimuli.update({ id: In(ids) }, { attempted_at: new Date() });
  }

  /** Mark a chat stimulus delivered (idempotent — only stamps a still-null row). */
  async markChatDelivered(id: string): Promise<void> {
    await this.stimuli.update(
      { id, delivered_at: IsNull() },
      { delivered_at: new Date() },
    );
  }

  /**
   * Every still-undelivered chat stimulus on a lane, ignoring the delivery lease. Used only at terminal
   * lane teardown, where a leased-but-unacked build-lane seed must not be stranded just because the normal
   * retry window has not expired yet.
   */
  async undeliveredChatForLane(
    jobId: string,
    lane: string,
  ): Promise<TurnEnvelope[]> {
    const rows = await this.stimuli
      .createQueryBuilder('s')
      .where('s.kind = :k', { k: 'chat' })
      .andWhere('s.job_id = :j', { j: jobId })
      .andWhere("COALESCE(s.lane, 'main') = :lane", { lane })
      .andWhere('s.delivered_at IS NULL')
      .orderBy('s.created_at', 'ASC')
      .getMany();
    return rows.map((r) => this.rowToEnvelope(r));
  }

  /**
   * Re-key a still-undelivered chat stimulus onto the `main` lane, replacing its body — the build-lane
   * thread-end escalation backstop (see `AgentSessionManager.escalateBuildLaneLeftovers`). Leaves
   * `delivered_at` NULL and clears any old delivery lease so the brain's existing main pump/sweep can pick
   * it up immediately; only touches a still-null row (idempotent alongside a racing sweep that already
   * delivered it under its old lane).
   */
  async rekeyLaneToMain(id: string, labeledBody: string): Promise<void> {
    await this.stimuli.update(
      { id, delivered_at: IsNull() },
      { lane: 'main', body: labeledBody, attempted_at: null },
    );
  }

  /** Reconstruct a single chat stimulus by id (the durable stimuli.id), or null. Used by the brain to
   *  resolve a delivered row's seed stamp targets (seedQuestionId/seedSecretId/seedFileId) from reply_route. */
  async findChatStimulusById(id: string): Promise<TurnEnvelope | null> {
    const row = await this.stimuli.findOne({ where: { id, kind: 'chat' } });
    return row ? this.rowToEnvelope(row) : null;
  }

  /**
   * True when the thread already has a LIVE (undelivered) chat stimulus row whose `reply_route` points at the
   * given seed card target. The boot backfill (AgentSessionManager) uses this to skip re-creating a durable row
   * the pump already owns — so boot recovery and the steady-state sweep never double-deliver one answered/
   * provided card. NOT-EXISTS style: a delivered row means the pump is done, so it does NOT block a backfill.
   */
  async hasChatStimulusForSeedTarget(
    jobId: string,
    target: {
      seedQuestionId?: string;
      seedSecretId?: string;
      seedFileId?: string;
      bornBlockedSeed?: boolean;
      blockNote?: boolean;
      unblockNote?: boolean;
    },
  ): Promise<boolean> {
    const qb = this.stimuli
      .createQueryBuilder('s')
      .where('s.kind = :k', { k: 'chat' })
      .andWhere('s.job_id = :j', { j: jobId })
      .andWhere('s.delivered_at IS NULL');
    // Each target must match EITHER the singular key OR the plural array (a combined `answer-batch` seed
    // carries the id inside `seed*Ids`, never the singular `seed*Id`). `jsonb_exists(arr, :id)` is the
    // function form of the `?` array-contains operator, used to avoid a bare `?` colliding with the pg
    // driver's placeholder syntax; it is NULL-safe when the plural key is absent.
    let hasTarget = false;
    if (target.seedQuestionId) {
      qb.andWhere(
        "(s.reply_route ->> 'seedQuestionId' = :q OR jsonb_exists(s.reply_route -> 'seedQuestionIds', :q))",
        { q: target.seedQuestionId },
      );
      hasTarget = true;
    }
    if (target.seedSecretId) {
      qb.andWhere(
        "(s.reply_route ->> 'seedSecretId' = :sec OR jsonb_exists(s.reply_route -> 'seedSecretIds', :sec))",
        { sec: target.seedSecretId },
      );
      hasTarget = true;
    }
    if (target.seedFileId) {
      qb.andWhere(
        "(s.reply_route ->> 'seedFileId' = :f OR jsonb_exists(s.reply_route -> 'seedFileIds', :f))",
        { f: target.seedFileId },
      );
      hasTarget = true;
    }
    if (target.bornBlockedSeed) {
      qb.andWhere("s.reply_route ->> 'bornBlockedSeed' = 'true'");
      hasTarget = true;
    }
    if (target.blockNote) {
      qb.andWhere("s.reply_route ->> 'blockNote' = 'true'");
      hasTarget = true;
    }
    if (target.unblockNote) {
      qb.andWhere("s.reply_route ->> 'unblockNote' = 'true'");
      hasTarget = true;
    }
    if (!hasTarget) return false;
    return (await qb.getCount()) > 0;
  }

  /** True when the job has at least one durable undelivered chat stimulus (excluding `later`-priority rows,
   *  same filter as {@link undeliveredChatThreads}) — the auto-merge brain-settled guard's queue check. */
  async hasUndeliveredChat(jobId: string): Promise<boolean> {
    return this.stimuli
      .createQueryBuilder('s')
      .where('s.kind = :k', { k: 'chat' })
      .andWhere('s.job_id = :j', { j: jobId })
      .andWhere('s.delivered_at IS NULL')
      .andWhere(
        "(s.reply_route ->> 'priority' IS NULL OR s.reply_route ->> 'priority' != 'later')",
      )
      .getExists();
  }

  /** Distinct (thread, org, repo) tuples with at least one undelivered chat stimulus — the sweep worklist. */
  async undeliveredChatThreads(): Promise<
    Array<{ jobId: string; orgId: string; repoId: string }>
  > {
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
      .andWhere(
        "(s.reply_route ->> 'priority' IS NULL OR s.reply_route ->> 'priority' != 'later')",
      )
      .getRawMany<{ job_id: string; org_id: string; repo_id: string }>();
    return rows.map((r) => ({
      jobId: r.job_id,
      orgId: r.org_id,
      repoId: r.repo_id,
    }));
  }

  /**
   * Distinct (thread, org, repo, lane) tuples with at least one undelivered chat stimulus — the lane-aware
   * sweep worklist. A NEW method (rather than widening {@link undeliveredChatThreads}) so its existing
   * job-keyed caller keeps compiling unchanged; a lane-generic sweep calls this one instead. Legacy NULL
   * `lane` rows are grouped under `'main'`.
   */
  async undeliveredChatLanes(): Promise<
    Array<{ jobId: string; orgId: string; repoId: string; lane: string }>
  > {
    const rows = await this.stimuli
      .createQueryBuilder('s')
      .select('s.job_id', 'job_id')
      .addSelect('s.org_id', 'org_id')
      .addSelect('s.repo_id', 'repo_id')
      .addSelect("COALESCE(s.lane, 'main')", 'lane')
      .distinct(true)
      .where('s.kind = :k', { k: 'chat' })
      .andWhere('s.delivered_at IS NULL')
      .andWhere('s.job_id IS NOT NULL')
      // A thread whose ONLY undelivered rows are `later` must not be swept awake — `later` only rides
      // along a turn that runs for some other reason (d18).
      .andWhere(
        "(s.reply_route ->> 'priority' IS NULL OR s.reply_route ->> 'priority' != 'later')",
      )
      .getRawMany<{
        job_id: string;
        org_id: string;
        repo_id: string;
        lane: string;
      }>();
    return rows.map((r) => ({
      jobId: r.job_id,
      orgId: r.org_id,
      repoId: r.repo_id,
      lane: r.lane,
    }));
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

  /** Every eligible pending event (undelivered + lease-free), oldest first, as EventMessage — the sweep worklist. */
  async eligiblePendingEvents(leaseMs: number): Promise<EventMessage[]> {
    const cutoff = new Date(Date.now() - leaseMs);
    const rows = await this.stimuli
      .createQueryBuilder('s')
      .where('s.kind = :k', { k: 'event' })
      .andWhere('s.delivered_at IS NULL')
      .andWhere('s.job_id IS NOT NULL')
      .andWhere('(s.attempted_at IS NULL OR s.attempted_at < :cutoff)', {
        cutoff,
      })
      .orderBy('s.created_at', 'ASC')
      .getMany();
    return rows.map((r) => this.rowToEventMessage(r));
  }

  /** Clear the lease on every undelivered event row (boot reconcile — re-drive anything mid-attempt at crash). */
  async resetEventLeases(): Promise<void> {
    await this.stimuli.update(
      { kind: 'event', delivered_at: IsNull() },
      { attempted_at: null },
    );
  }

  /** Reconstruct the `EventMessage` a persisted event row carries (for re-drive). Body is the CLEAN text —
   *  the untrusted fence is re-applied at the delivery seam (`renderEventDelivery`). `resumeThreadId`
   *  round-trips through the persisted `lane` (`thread:<id>`) so a sweep re-drive routes identically to the
   *  first delivery attempt (see `attachEventToJob`'s §CI-routing). `eventKind` is not persisted on the row
   *  (it rode the transcript `meta` at intake) — the render path only reads `source`/`severity`/`body`, so a
   *  re-drive supplies a benign fallback. `correlation` is transient — already consumed at routing. */
  private rowToEventMessage(row: InboundMessageEntity): EventMessage {
    const resumeThreadId = resumeThreadIdFromLane(row.lane);
    return {
      id: row.id,
      type: 'event',
      trust: 'untrusted',
      orgId: row.org_id,
      repoId: row.repo_id,
      jobId: row.job_id as string,
      body: row.body,
      source: row.source ?? 'webhook',
      // Not persisted on the inbound row (it rode the transcript `meta` at intake) and never read by the
      // render path (`renderEventDelivery` reads only source/severity/body) — a benign fallback on re-drive.
      eventKind: 'ci_failure',
      dedupeKey: row.dedupe_key ?? '',
      severity: (row.severity as EventSeverity | null) ?? 'info',
      receivedAt: row.created_at.toISOString(),
      ...(resumeThreadId ? { resumeThreadId } : {}),
    };
  }

  /** Reconstruct the `TurnEnvelope` a persisted chat/seed row carries (for re-drive). `message` is a
   *  documented partial (see {@link reconstructMessage}) keyed on the persisted `type`; the delivered-card
   *  ids collapse the persisted singular `seed*Id` + plural `seed*Ids` reply_route keys into one array each. */
  private rowToEnvelope(row: InboundMessageEntity): TurnEnvelope {
    const replyRoute: ReplyRouteJson | null = row.reply_route;
    const resumeThreadId = resumeThreadIdFromLane(row.lane);
    const author = {
      id: row.author_id ?? '',
      // Rows written before author_name existed fall back to the scope id as the display label.
      displayName: row.author_name ?? row.author_id ?? 'operator',
    };
    const deliveredQuestionIds = collapseDeliveredIds(
      replyRoute?.seedQuestionId,
      replyRoute?.seedQuestionIds,
    );
    const deliveredSecretIds = collapseDeliveredIds(
      replyRoute?.seedSecretId,
      replyRoute?.seedSecretIds,
    );
    const deliveredFileIds = collapseDeliveredIds(
      replyRoute?.seedFileId,
      replyRoute?.seedFileIds,
    );
    return {
      message: reconstructMessage({
        id: row.id,
        orgId: row.org_id,
        repoId: row.repo_id,
        jobId: row.job_id as string,
        receivedAt: row.created_at,
        type: (row.type as string | null) ?? 'user',
      }),
      id: row.id,
      orgId: row.org_id,
      repoId: row.repo_id,
      jobId: row.job_id as string,
      receivedAt: row.created_at,
      author,
      replyRoute: row.reply_route ?? {
        surfaceId: '',
        jobRef: row.job_id as string,
      },
      body: row.body,
      ...(replyRoute?.priority ? { priority: replyRoute.priority } : {}),
      ...(deliveredQuestionIds ? { deliveredQuestionIds } : {}),
      ...(deliveredSecretIds ? { deliveredSecretIds } : {}),
      ...(deliveredFileIds ? { deliveredFileIds } : {}),
      ...(resumeThreadId ? { resumeThreadId } : {}),
    };
  }
}

/**
 * Reconstruct the `TurnEnvelope.message` a persisted row (or a synthetic seed) carries when the full typed
 * variant is no longer at hand — the documented partial the durability seams rely on (mirrors `pumpEvent`'s
 * stopgap cast, and `reattachOne`'s ctx rebuild). Only `.type` + the `MessageBase` identity are real: the
 * variant-specific args were consumed by `composeMessageBody` at construction and the rendered body rides
 * `TurnEnvelope.body`, so nothing downstream of render reads them. `type` may be a persistence-only value
 * (`'seed'`) outside the `Message` union — legitimate on this reconstruction path, hence the `unknown` cast.
 */
function reconstructMessage(input: {
  id: string;
  orgId: string;
  repoId: string;
  jobId: string;
  receivedAt: Date;
  type: string;
}): Message {
  return {
    id: input.id,
    orgId: input.orgId,
    repoId: input.repoId,
    jobId: input.jobId,
    receivedAt: input.receivedAt.toISOString(),
    type: input.type,
  } as unknown as Message;
}

/** Collapse a singular delivered-card id + its batch-array counterpart into one array (or undefined when
 *  neither is present) — the envelope's one delivered-id name per kind. Dedupes so a row carrying both the
 *  singular key and the same id in the plural array stamps the card once. */
function collapseDeliveredIds(
  single: string | undefined,
  plural: string[] | undefined,
): string[] | undefined {
  const ids = new Set<string>();
  if (single) ids.add(single);
  for (const id of plural ?? []) ids.add(id);
  return ids.size ? [...ids] : undefined;
}

/** The `thread:<id>` routing coordinate a persisted `lane` encodes, or `undefined` for `'main'`/absent —
 *  the single source of truth for reconstructing a stimulus's `resumeThreadId` from its durable lane. */
function resumeThreadIdFromLane(
  lane: string | null | undefined,
): string | undefined {
  return lane?.startsWith('thread:') ? lane.slice('thread:'.length) : undefined;
}

/**
 * Pick the blocked-overlay preview out of a job's undelivered `main`-lane rows (oldest-first): the opening
 * BRIEF when a born-blocked provenance note is queued (the brief is its flag-less `follow_up_job_seed`
 * sibling), else the mid-flight "blocked" note body, else null.
 */
function pickBlockedPreview(rows: InboundMessageEntity[]): string | null {
  const flag = (r: InboundMessageEntity): ReplyRouteJson | null =>
    r.reply_route as ReplyRouteJson | null;
  const bornBlocked = rows.some((r) => flag(r)?.bornBlockedSeed);
  if (bornBlocked) {
    const brief = rows.find(
      (r) => r.type === 'follow_up_job_seed' && !flag(r)?.bornBlockedSeed,
    );
    return brief?.body ?? null;
  }
  const blockNote = rows.find((r) => flag(r)?.blockNote);
  return blockNote?.body ?? null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}
