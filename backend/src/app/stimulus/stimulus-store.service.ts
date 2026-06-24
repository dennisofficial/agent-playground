import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import type {
  ChatStimulus,
  EventStimulus,
  Stimulus,
} from '../domain';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  MessageEntity,
  StimulusEntity,
  ThreadEntity,
} from '../persistence/entities';

/** A persisted event stimulus + the thread it seeded. */
export interface SeededEvent {
  stimulus: EventStimulus;
  thread: ThreadEntity;
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
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @InjectRepository(MessageEntity, DB_CONNECTION)
    private readonly messages: Repository<MessageEntity>,
    @InjectRepository(StimulusEntity, DB_CONNECTION)
    private readonly stimuli: Repository<StimulusEntity>,
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
    const thread = await this.threads.save(
      this.threads.create({
        org_id: input.orgId,
        repo_id: input.repoId,
        origin: 'event',
        surface_thread_ref: null, // set when the announcement is posted (W6)
        title: input.title,
      }),
    );

    const message = await this.messages.save(
      this.messages.create({
        thread_id: thread.id,
        author: input.source,
        author_id: input.source,
        author_bot_id: null,
        text: input.body,
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
          thread_id: thread.id,
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
        await this.threads.delete({ id: thread.id }).catch(() => undefined);
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
      body: input.body,
      source: input.source,
      dedupeKey: input.dedupeKey,
      severity: input.severity,
      receivedAt: row.created_at,
    };
    return { stimulus, thread, message };
  }

  /**
   * Persist a chat message continuing an existing thread + its chat stimulus row. Returns the
   * `ChatStimulus` with its minted id. No new thread, no dedupe (chat bypasses the filter).
   */
  async recordChatStimulus(input: {
    orgId: string;
    repoId: string;
    threadId: string;
    author: { id: string; displayName: string };
    replyRoute: { surfaceId: string; threadRef: string };
    body: string;
  }): Promise<ChatStimulus> {
    await this.messages.save(
      this.messages.create({
        thread_id: input.threadId,
        author: input.author.displayName,
        author_id: input.author.id,
        author_bot_id: null,
        text: input.body,
      }),
    );

    const row = await this.stimuli.save(
      this.stimuli.create({
        org_id: input.orgId,
        repo_id: input.repoId,
        kind: 'chat',
        trust: 'trusted',
        body: input.body,
        thread_id: input.threadId,
        author_id: input.author.id,
        reply_route: input.replyRoute,
        source: null,
        dedupe_key: null,
        severity: null,
      }),
    );

    return {
      id: row.id,
      orgId: input.orgId,
      repoId: input.repoId,
      kind: 'chat',
      trust: 'trusted',
      body: input.body,
      threadId: input.threadId,
      author: input.author,
      replyRoute: input.replyRoute,
      receivedAt: row.created_at,
    };
  }

  /** Persist any already-built `Stimulus` (test/utility helper). */
  describe(stimulus: Stimulus): string {
    return `${stimulus.kind}:${stimulus.id}`;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}
