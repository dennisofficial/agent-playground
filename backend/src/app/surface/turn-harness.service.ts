import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type QueryDeepPartialEntity, Repository } from 'typeorm';
import {
  type ContextBreakdown,
  type EngineEvent,
  type EngineUsage,
  type JitInjection,
  resolveContextLimit,
} from '@shared/engine';
import { AppVersionService } from '../cluster/app-version.service';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  TranscriptMessageEntity,
  ThreadGroupEntity,
  SubagentEntity,
  TaskEntity,
  type TaskItem,
  ThreadEntity,
} from '../persistence/entities';
import { isInterruptAbortResult } from '../brain/session-transcript';
import { LiveTurnStore } from './live-turn-store';
import { type TaskScope } from './thread-registry';
import {
  applyEdge,
  hasBlockedByInput,
  inverseEdgeOps,
  isStr,
  mergeBlockedBy,
} from './task-edges';
import { OauthUsageService } from '../onboarding/oauth-usage.service';

/**
 * The durable destination for a turn's transcript blocks — a narrow port (just `appendBlock`) so a
 * consumer (the driver) can ride the shared {@link TurnHarnessFactory} WITHOUT pulling the whole brain
 * module (and the cycle that would create). Implemented by {@link MessageBlockSink}.
 */
export interface BlockSink {
  /** Returns the written row's `id` (or the existing row's `id`, on an idempotent no-op) so a caller can
   *  resolve a just-written block's row — e.g. a subagent's spawning anchor's `id` becomes that subagent's
   *  `subagents.parent_message_id`. */
  appendBlock(
    jobId: string,
    block: {
      kind: string;
      threadId: string;
      text?: string;
      meta?: Record<string, unknown> | null;
      createdAt?: Date;
      idemKey?: string;
      /** The subagent this block belongs to (its OWN transcript, not its spawning anchor) — stamped onto
       *  `messages.subagent_id`. Absent for a block that isn't part of a subagent's own transcript. */
      subagentId?: string;
    },
  ): Promise<string | undefined>;
  /**
   * Insert-once by a durable idempotency key: append the block ONLY if no `agent_prompt` row for this
   * job already carries `meta.promptKey === promptKey`. This is what makes the per-turn prompt block
   * safe to (re)emit across restart / re-kick / re-drive / plan-review resume-retry — the durable row is
   * the dedup, not a fragile "kick vs reattach" branch in the caller. Best-effort; never throws.
   */
  appendBlockOnce(
    jobId: string,
    promptKey: string,
    block: {
      kind: string;
      threadId: string;
      text?: string;
      meta?: Record<string, unknown> | null;
      createdAt?: Date;
    },
  ): Promise<void>;
}

/** DI token for {@link BlockSink}. */
export const BLOCK_SINK = Symbol('BLOCK_SINK');

/**
 * The default {@link BlockSink} — writes a durable transcript block straight to `messages`. Byte-identical
 * to `BrainStoreService.appendBlock` (authored by Atlas; honors the block's emission `createdAt`), lifted
 * here so the brain AND the driver share ONE writer.
 */
@Injectable()
export class MessageBlockSink implements BlockSink {
  constructor(
    @InjectRepository(TranscriptMessageEntity, DB_CONNECTION)
    private readonly messages: Repository<TranscriptMessageEntity>,
    private readonly version: AppVersionService,
  ) {}

  async appendBlock(
    jobId: string,
    block: {
      kind: string;
      threadId: string;
      text?: string;
      meta?: Record<string, unknown> | null;
      createdAt?: Date;
      idemKey?: string;
      subagentId?: string;
    },
  ): Promise<string | undefined> {
    const row = {
      job_id: jobId,
      thread_id: block.threadId,
      author: 'Atlas',
      author_id: 'atlas',
      author_bot_id: 'atlas',
      text: block.text ?? '',
      kind: block.kind,
      meta: block.meta ?? null,
      subagent_id: block.subagentId ?? null,
      engine_git_sha: this.version.sha,
      ...(block.createdAt ? { created_at: block.createdAt } : {}),
    };
    if (block.idemKey) {
      // ON CONFLICT DO NOTHING on the partial unique index `ux_messages_idem_key`: a repeat write of the same
      // `${turn_id}:${ordinal}` (two racing finishers, a redelivery) is a no-op instead of a duplicate row.
      const result = await this.messages
        .createQueryBuilder()
        .insert()
        .values({
          ...row,
          idem_key: block.idemKey,
        } as QueryDeepPartialEntity<TranscriptMessageEntity>)
        .orIgnore()
        .execute();
      const insertedId = result.identifiers?.[0]?.id as string | undefined;
      if (insertedId) return insertedId;
      // A conflict (ON CONFLICT DO NOTHING) may not report an id — look up the existing row by its key.
      const existing = await this.messages.findOne({
        where: { idem_key: block.idemKey },
        select: { id: true },
      });
      return existing?.id;
    }
    const saved = await this.messages.save(this.messages.create(row));
    return saved.id;
  }

  async appendBlockOnce(
    jobId: string,
    promptKey: string,
    block: {
      kind: string;
      threadId: string;
      text?: string;
      meta?: Record<string, unknown> | null;
      createdAt?: Date;
    },
  ): Promise<void> {
    // A job accumulates only a handful of `agent_prompt` rows (one per brain turn / review round / gate
    // iteration / lens), so loading them and filtering by `meta.promptKey` in JS is cheap and avoids
    // jsonb-containment SQL. If one already carries this key the emission is a no-op.
    const existing = await this.messages.find({
      where: { job_id: jobId, kind: 'agent_prompt' },
      select: { id: true, meta: true },
    });
    if (
      existing.some(
        (m) =>
          (m.meta as { promptKey?: string } | null)?.promptKey === promptKey,
      )
    ) {
      return;
    }
    // Stamp the key into meta so the dedup read above finds it on the NEXT call — the single source of
    // truth, whether the caller went through the harness's `emitPrompt` or wrote the block directly.
    await this.appendBlock(jobId, {
      ...block,
      threadId: block.threadId,
      meta: { ...(block.meta ?? {}), promptKey },
    });
  }
}

/**
 * The durable store behind the `task_create`/`task_update`/`task_list`/`task_get` host-bridge tools — a
 * narrow port (mirrors {@link BlockSink}) so the bridge handler factory ({@link makeTaskTools}) can do
 * direct CRUD on the thread-group-owned `tasks` table WITHOUT depending on the driver module (and the cycle that
 * would create, since the driver already depends on {@link TurnHarnessFactory}). ONE durable id space: the
 * short per-stage `#N` (the row's `ordinal`) `createTask` returns is the SAME id `readTasks` reports, so any
 * of them is a valid `updateTask` key (no per-session reconcile). The uuid PK stays the internal row
 * identity / FK target. Implemented by {@link EntityTaskEventSink}.
 */
export interface TaskEventSink {
  /** INSERT one task row into the scope's thread group; returns its short per-stage `#N` id (the row's dense
   *  `ordinal`). Throws if the scope's thread group can't be resolved (the caller has already validated the
   *  input). */
  createTask(
    scope: TaskScope,
    input: Record<string, unknown>,
  ): Promise<{ id: string }>;
  /** UPDATE (or, on `status:'deleted'`, remove) the row named by `input.taskId` within the scope's thread group. */
  updateTask(
    scope: TaskScope,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }>;
  /** The scope's current checklist, read FRESH from the durable rows (no cache) — ordinal-ordered. */
  readTasks(scope: TaskScope): Promise<TaskItem[]>;
}

/** DI token for {@link TaskEventSink}. */
export const TASK_EVENT_SINK = Symbol('TASK_EVENT_SINK');

/**
 * The default {@link TaskEventSink} — direct CRUD on the thread-group-owned `tasks` rows (d6). The task-tool
 * id space is the row's short per-stage `#N` (`ordinal`), resolved to a row by (thread_group_id, ordinal);
 * the uuid PK is kept only for the actual delete/update WHERE. No session-scoped fold/reconcile is needed: a
 * `task_update` by an id sourced from `task_list` resolves the same row it names. Reads hit the DB fresh
 * every call, so a builder-leg rotation (a fresh session with an empty in-memory store) never loses the
 * carried checklist — the bug this replaced.
 */
@Injectable()
export class EntityTaskEventSink implements TaskEventSink {
  constructor(
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @InjectRepository(ThreadGroupEntity, DB_CONNECTION)
    private readonly threadGroups: Repository<ThreadGroupEntity>,
    @InjectRepository(TaskEntity, DB_CONNECTION)
    private readonly tasks: Repository<TaskEntity>,
  ) {}

  /**
   * Per-scope FIFO chain for MUTATIONS. A batch of task calls in one turn ("create · create · update")
   * lands as near-simultaneous bridge dispatches — unserialized, two creates read the same max ordinal and
   * collide, or two edits race a read-modify-write. Chaining per scope key preserves arrival order so each
   * mutation sees its predecessor's write. Pure reads (`readTasks`) do NOT queue here — they need no
   * serialization and shouldn't wait behind a slow write.
   */
  private readonly chains = new Map<string, Promise<unknown>>();

  /** Run `fn` inside this scope's mutation chain and return its result (FIFO; a rejection doesn't stall
   *  the chain, and the map entry is dropped once this tail settles so it can't grow unbounded). */
  private chain<T>(scope: TaskScope, fn: () => Promise<T>): Promise<T> {
    const key = `${scope.kind}:${scope.id}`;
    const run = (this.chains.get(key) ?? Promise.resolve()).then(fn);
    const tail = run
      .catch(() => undefined)
      .finally(() => {
        if (this.chains.get(key) === tail) this.chains.delete(key);
      });
    this.chains.set(key, tail);
    return run;
  }

  async createTask(
    scope: TaskScope,
    input: Record<string, unknown>,
  ): Promise<{ id: string }> {
    return this.chain(scope, async () => {
      const resolved = await this.resolveThreadGroupId(scope);
      if (!resolved)
        throw new Error(`task scope not found: ${scope.kind}:${scope.id}`);
      const { threadGroupId, orgId } = resolved;
      const ordinal = (await this.maxTaskOrdinal(threadGroupId)) + 1;
      const blockedBy = await this.validBlockedBy(
        threadGroupId,
        mergeBlockedBy([], input),
      );
      const created = await this.tasks.save(
        this.tasks.create({
          thread_group_id: threadGroupId,
          org_id: orgId,
          ordinal,
          title: String(input.subject ?? '').trim(),
          brief: isStr(input.description) ? input.description : null,
          active_form: isStr(input.activeForm) ? input.activeForm : null,
          status: 'pending',
          blocked_by: blockedBy,
        }),
      );
      await this.applyInverseEdges(threadGroupId, String(created.ordinal), input);
      return { id: String(created.ordinal) };
    });
  }

  async updateTask(
    scope: TaskScope,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.chain(scope, async () => {
      const resolved = await this.resolveThreadGroupId(scope);
      if (!resolved) return { ok: false, error: 'scope not found' };
      const { threadGroupId } = resolved;
      // `taskId` is now the short per-stage #N (the row's `ordinal`), not the uuid PK — resolve the target
      // by (thread_group_id, ordinal), then keep every real delete/update WHERE on the uuid PK.
      const ordinal = Number(String(input.taskId ?? '').trim());
      if (!Number.isInteger(ordinal))
        return { ok: false, error: `invalid taskId ${String(input.taskId)}` };
      const row = await this.tasks.findOne({
        where: { ordinal, thread_group_id: threadGroupId },
      });
      if (!row) return { ok: false, error: `task ${ordinal} not found` };

      // A deletion REMOVES the row. Keep sibling edges in the same #N id space too: old fold/reconcile
      // dropped references to rows that no longer existed, and `task_list` should not report a deleted id as
      // a blocker.
      if (input.status === 'deleted') {
        await this.tasks.delete({ id: row.id });
        await this.removeBlockedByReference(threadGroupId, String(row.ordinal));
        return { ok: true };
      }

      const patch: QueryDeepPartialEntity<TaskEntity> = {};
      if (isStr(input.subject)) patch.title = input.subject;
      if (isStr(input.description)) patch.brief = input.description;
      if (isStr(input.activeForm)) patch.active_form = input.activeForm;
      const status = mapTaskStatus(input.status);
      if (status) patch.status = status;
      if (hasBlockedByInput(input))
        patch.blocked_by = await this.validBlockedBy(
          threadGroupId,
          mergeBlockedBy(row.blocked_by ?? [], input),
          String(row.ordinal),
        );
      if (Object.keys(patch).length)
        await this.tasks.update({ id: row.id }, patch);

      await this.applyInverseEdges(threadGroupId, String(row.ordinal), input);
      return { ok: true };
    });
  }

  async readTasks(scope: TaskScope): Promise<TaskItem[]> {
    const resolved = await this.resolveThreadGroupId(scope);
    if (!resolved) return [];
    const rows = await this.tasks.find({
      where: { thread_group_id: resolved.threadGroupId },
      order: { ordinal: 'ASC' },
    });
    return rows.map(toTaskItem);
  }

  /** Resolve the thread group that owns this scope's shared checklist: a `thread` scope's own `thread_group_id`, or a
   *  `main` scope's job's `planning` thread group (mirrors `DriverStoreService.planningThreadId`'s lookup). */
  private async resolveThreadGroupId(
    scope: TaskScope,
  ): Promise<{ threadGroupId: string; orgId: string } | null> {
    if (scope.kind === 'thread') {
      const thread = await this.threads.findOne({
        where: { id: scope.id },
        select: { id: true, thread_group_id: true, org_id: true },
      });
      return thread ? { threadGroupId: thread.thread_group_id, orgId: thread.org_id } : null;
    }
    // scope.kind === 'main' — the job's planning thread group owns the brain's own checklist.
    const threadGroup = await this.threadGroups.findOne({
      where: { job_id: scope.id, kind: 'planning' },
      order: { ordinal: 'ASC' },
      select: { id: true, org_id: true },
    });
    return threadGroup ? { threadGroupId: threadGroup.id, orgId: threadGroup.org_id } : null;
  }

  /** Apply the INVERSE dependency edges (`addBlocks`/`removeBlocks`: "this task blocks X") onto each named
   *  target row's `blocked_by`. `targetId`/`sourceId` are short #N (ordinal) ids; a target that isn't a row
   *  in THIS thread group is silently skipped (mirrors the old fold's behavior — no dangling edges). */
  private async applyInverseEdges(
    threadGroupId: string,
    sourceId: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    for (const { targetId, op } of inverseEdgeOps(input)) {
      const targetOrdinal = Number(targetId);
      if (!Number.isInteger(targetOrdinal)) continue;
      const target = await this.tasks.findOne({
        where: { ordinal: targetOrdinal, thread_group_id: threadGroupId },
      });
      if (!target) continue;
      await this.tasks.update(
        { id: target.id },
        { blocked_by: applyEdge(target.blocked_by ?? [], sourceId, op) },
      );
    }
  }

  /** Keep `blocked_by` in the same thread-group-owned #N (ordinal) id space as the rows themselves. Unknown
   *  ids are dropped instead of being persisted as dangling blockers. */
  private async validBlockedBy(
    threadGroupId: string,
    ids: string[],
    selfId?: string,
  ): Promise<string[]> {
    const unique = [...new Set(ids.filter((id) => id !== selfId))];
    if (unique.length === 0) return [];
    const rows = await this.tasks.find({
      where: { thread_group_id: threadGroupId },
      select: { ordinal: true },
    });
    const valid = new Set(rows.map((row) => String(row.ordinal)));
    return unique.filter((id) => valid.has(id));
  }

  private async removeBlockedByReference(
    threadGroupId: string,
    sourceId: string,
  ): Promise<void> {
    const rows = await this.tasks.find({
      where: { thread_group_id: threadGroupId },
      select: { id: true, blocked_by: true },
    });
    for (const row of rows) {
      const next = (row.blocked_by ?? []).filter((id) => id !== sourceId);
      if (next.length !== (row.blocked_by ?? []).length)
        await this.tasks.update({ id: row.id }, { blocked_by: next });
    }
  }

  private async maxTaskOrdinal(threadGroupId: string): Promise<number> {
    const row = await this.tasks
      .createQueryBuilder('t')
      .select('MAX(t.ordinal)', 'max')
      .where('t.thread_group_id = :threadGroupId', { threadGroupId })
      .getRawOne<{ max: number | null }>();
    return row?.max ?? 0;
  }
}

/** Map a `task_update` status onto a persisted status. `deleted` is handled before this (a deleted task
 *  is REMOVED, not stored); `dropped` is a DB-only status this tool surface never sets. */
function mapTaskStatus(
  raw: unknown,
): 'pending' | 'in_progress' | 'completed' | null {
  return raw === 'pending' || raw === 'in_progress' || raw === 'completed'
    ? raw
    : null;
}

/** Map a thread-group-owned {@link TaskEntity} row back to the `TaskItem` wire/domain shape (mirrors
 *  `DriverStoreService`'s own copy — kept local to avoid a cross-module dependency on the driver). */
function toTaskItem(row: TaskEntity): TaskItem {
  return {
    id: String(row.ordinal),
    subject: row.title,
    status: row.status as TaskItem['status'],
    ...(row.brief != null ? { description: row.brief } : {}),
    ...(row.active_form != null ? { activeForm: row.active_form } : {}),
    ...(row.blocked_by?.length ? { blockedBy: row.blocked_by } : {}),
  };
}

/**
 * The destination for one subagent's lifecycle row — a narrow port (mirrors {@link BlockSink}) so the
 * harness can populate `subagents` (d4) WITHOUT a module cycle. Implemented by {@link EntitySubagentStore}.
 */
export interface SubagentStore {
  /**
   * Insert (or, on a repeat call with the SAME `id`, upsert) one subagent's row. The harness generates
   * `id` client-side once per spawn and always upserts that SAME id, so a re-drive/re-persist of the same
   * turn converges instead of duplicating. Best-effort — never throws into the turn.
   */
  upsert(input: {
    id: string;
    threadId: string;
    parentMessageId: string;
    toolUseId: string;
    agentType: string | null;
    model: string | null;
    status: 'running' | 'done' | 'failed';
    startedAt: Date;
    endedAt: Date | null;
  }): Promise<void>;
}

/** DI token for {@link SubagentStore}. */
export const SUBAGENT_STORE = Symbol('SUBAGENT_STORE');

/** A no-op {@link SubagentStore} — the constructor default for a call site that builds a
 *  {@link TurnHarnessFactory} directly (bypassing Nest DI, e.g. an existing test) without one. */
const NOOP_SUBAGENT_STORE: SubagentStore = { upsert: async () => undefined };

/** The default {@link SubagentStore} — upserts straight into `subagents`. */
@Injectable()
export class EntitySubagentStore implements SubagentStore {
  private readonly logger = new Logger(EntitySubagentStore.name);

  constructor(
    @InjectRepository(SubagentEntity, DB_CONNECTION)
    private readonly subagents: Repository<SubagentEntity>,
  ) {}

  async upsert(input: {
    id: string;
    threadId: string;
    parentMessageId: string;
    toolUseId: string;
    agentType: string | null;
    model: string | null;
    status: 'running' | 'done' | 'failed';
    startedAt: Date;
    endedAt: Date | null;
  }): Promise<void> {
    try {
      await this.subagents.upsert(
        {
          id: input.id,
          thread_id: input.threadId,
          parent_message_id: input.parentMessageId,
          tool_use_id: input.toolUseId,
          agent_type: input.agentType,
          model: input.model,
          status: input.status,
          started_at: input.startedAt,
          ended_at: input.endedAt,
        },
        ['id'],
      );
    } catch (err) {
      this.logger.warn(`subagent upsert failed (ignored): ${err}`);
    }
  }
}

/**
 * Turn-end accounting, rendered as a durable `turn_meta` block (the per-turn divider + context ring in the
 * web). All optional — pass nothing (or no `usage`) and no block is written.
 */
export interface TurnEndMeta {
  /** The turn's token usage as the engine reported it (in/out/cache/cost/model). */
  usage?: EngineUsage;
  /** Context-window occupancy proxy — the last request's input tokens (incl. cache). */
  contextTokens?: number | null;
  /** The model's context-window size, for the occupancy ring. */
  contextLimit?: number;
  /** Full per-category context breakdown for the occupancy ring's popover — Claude-only; absent when the
   *  SDK's `getContextUsage()` was unavailable/errored for this turn. */
  contextBreakdown?: ContextBreakdown | null;
  /** The claude_credentials.id that authed this turn (Claude only); folded into turn_meta.meta for
   *  transcript visibility. */
  credentialId?: string | null;
}

/** One live turn's harness — the object a producer feeds engine events into. */
export interface TurnHarness {
  /** Feed one engine event: fans it live (LiveTurnStore) AND accumulates the authoritative durable block. */
  onEvent(e: EngineEvent): void;
  /**
   * Surface THIS turn's initial task (its "first message" — the prompt the engine actually received) as a
   * durable `agent_prompt` block on this harness's lane, so the operator can see exactly what the agent was
   * asked (the `task` is a plain engine param, never an event, so nothing else persists it). Insert-once by
   * `promptKey` (survives restart/re-kick/re-drive). Best-effort — never throws into the turn.
   */
  emitPrompt(
    task: string,
    promptKey: string,
    extraMeta?: Record<string, unknown>,
  ): Promise<void>;
  /**
   * Persist the accumulated transcript (+ a text fallback if none emitted), append a `turn_meta` block when
   * `turnMeta.usage` is present, then end the live lane.
   */
  finish(finalText?: string, turnMeta?: TurnEndMeta): Promise<void>;
  /** Persist whatever partials accumulated (no fallback) and end the live lane — for error/timeout paths. */
  abort(): Promise<void>;
  /** End the live lane and persist NOTHING — for a benign abort that will be RE-DELIVERED in full, so the
   *  truncated partial never becomes a durable half-message. */
  discard(): Promise<void>;
  /** Bind the engine turn id AFTER creation (the fresh-run path learns it from `runner.run`'s result). Stamps
   *  each persisted block a stable `${turnId}:${ordinal}` idempotency key. No-op if already set at create time. */
  bindTurnId(turnId: string): void;
}

export interface TurnHarnessOptions {
  /** The thread whose durable log + live stream this turn writes to. */
  jobId: string;
  /** The real `threads.id` row every durable block from this turn is stamped onto (NOT NULL on `messages`). */
  threadId: string;
  /** The org this turn runs under — the key `rate_limit` frames harvest into {@link OauthUsageService}.
   *  Optional: when absent (e.g. an org-less internal turn), rate-limit frames are simply not harvested. */
  orgId?: string;
  /** The repo channel the LiveTurnStore keys its stream by. */
  channel: string;
  /** Which lane this turn streams on. `'main'` = the brain; `'phase:<stepId>'` = a build turn. Default `'main'`. */
  lane?: string;
  /**
   * Extra metadata merged into EVERY durable block's `meta` (e.g. `{ phaseId, batchOrdinal }` for a build
   * turn so the web peels it into the step sub-page). Merged FIRST so it can never clobber the block's own
   * `id`/`parentToolUseId`/`result`.
   */
  metaTag?: Record<string, unknown>;
  /** The engine turn id, for the create-time path (reattach). Stamps each brain block a stable identity key
   *  `${turnId}:${ordinal}` so a repeat (re)persist upserts instead of duplicating. Absent ⇒ blocks keep
   *  `idem_key = NULL` (build/plan-review lanes, legacy). */
  turnId?: string;
  /**
   * Mirror each engine event into `LiveTurnStore` from this harness. Default false because the real Redis
   * runner owns live push through an independent consumer group; faked/direct runners can opt in so the same
   * full-App flow still has a resumable live buffer.
   */
  livePush?: boolean;
}

/**
 * THE SHARED TRANSCRIPT SPINE.
 *
 * Lifted verbatim from the brain's former `makeTurnStreamer` so EVERY engine turn — the thread brain, a
 * build phase, a nested subagent — converts its engine event stream into the AUTHORITATIVE durable blocks
 * (`chat`/`thinking`/`tool`), persisted at turn END via {@link BlockSink} (+ an optional usage harvest).
 *
 * The LIVE, resumable push to {@link LiveTurnStore} is normally done by RedisEngineRunner's independent
 * `realtime` consumer group (`liveRoute`), so a slow persistence path here can't delay the operator's live
 * view. Faked/direct runners can opt this harness back into live mirroring. This factory still owns the live
 * lane's LIFECYCLE (end/reset).
 *
 * What varies per role is ONLY the message sink: the `lane` it streams on and the `metaTag` stamped on its
 * blocks. Persisting at turn-END only (never mid-turn) is what prevents a double-render on reconnect: during
 * the turn the LiveTurnStore lane is the SOLE source; after `finish` the durable rows take over.
 */
@Injectable()
export class TurnHarnessFactory {
  private readonly logger = new Logger(TurnHarnessFactory.name);

  constructor(
    private readonly liveTurns: LiveTurnStore,
    @Inject(BLOCK_SINK) private readonly sink: BlockSink,
    private readonly usage: OauthUsageService,
    @Inject(SUBAGENT_STORE)
    private readonly subagentStore: SubagentStore = NOOP_SUBAGENT_STORE,
  ) {}

  /**
   * Clear any stale live-turn state left on `lane` by a prior attempt that never reached
   * finish/abort/discard, so a reattach's '0-0' replay repopulates a CLEAN buffer. Silent (no turn_end);
   * guarded so it only acts when the lane actually has live state (empty boot path stays a no-op).
   */
  resetLane(channel: string, jobId: string, lane: string = 'main'): void {
    if (this.liveTurns.snapshot(channel, jobId, lane)) {
      this.liveTurns.reset(channel, jobId, lane);
    }
  }

  create(options: TurnHarnessOptions): TurnHarness {
    const { jobId, orgId, channel, threadId } = options;
    const lane = options.lane ?? 'main';
    const metaTag = options.metaTag;
    const livePush = options.livePush === true;
    let persistTurnId = options.turnId;

    type DurableBlock = {
      kind: string;
      text?: string;
      meta?: Record<string, unknown>;
      toolId?: string;
      done?: boolean;
      emittedAt: Date;
    };
    const blocks: DurableBlock[] = [];

    type PendingSubagent = {
      id: string;
      toolUseId: string;
      agentType: string | null;
      model: string | null;
      status: 'running' | 'done' | 'failed';
      startedAt: Date;
      endedAt: Date | null;
    };
    const subagentsByToolUse = new Map<string, PendingSubagent>();

    let lastEmitMs = 0;
    // Strictly-monotonic emission stamps so blocks never tie within a turn (ms granularity); an interleaved
    // mid-turn user message (persisted at its real send time) then sorts correctly against them.
    const stamp = (): Date => {
      lastEmitMs = Math.max(Date.now(), lastEmitMs + 1);
      return new Date(lastEmitMs);
    };
    // Merge the per-role tag into a block's meta WITHOUT clobbering the block's own fields (the spread order
    // below always puts `metaTag` first). Returns undefined when there's nothing to attach (brain text).
    const tagMeta = (
      extra?: Record<string, unknown>,
    ): Record<string, unknown> | undefined => {
      const merged = { ...(metaTag ?? {}), ...(extra ?? {}) };
      return Object.keys(merged).length > 0 ? merged : undefined;
    };

    // Idempotent finalization: `finish`/`abort` run their body once; afterwards late `onEvent`s are dropped
    // so a turn that errors/times-out while still unwinding can never reopen the lane.
    let closed = false;
    let terminalReason: string | undefined;
    let stopReason: string | null | undefined;
    let streamClosedCount: number | undefined;

    const persistAll = async (): Promise<void> => {
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const idemKey = persistTurnId ? `${persistTurnId}:${i}` : undefined;
        const parentToolUseId = b.meta?.parentToolUseId as string | undefined;
        const subagentId = parentToolUseId
          ? subagentsByToolUse.get(parentToolUseId)?.id
          : undefined;
        const messageId = await this.sink
          .appendBlock(jobId, {
            kind: b.kind,
            threadId,
            createdAt: b.emittedAt,
            ...(b.text != null ? { text: b.text } : {}),
            ...(b.meta ? { meta: b.meta } : {}),
            ...(idemKey ? { idemKey } : {}),
            ...(subagentId ? { subagentId } : {}),
          })
          .catch((err) => {
            this.logger.warn(
              `appendBlock failed for thread=${jobId} lane=${lane}: ${err}`,
            );
            return undefined;
          });

        // This block IS a subagent's spawning anchor (a tracked Task tool_use) — now that its own message
        // row is persisted, upsert the `subagents` row with a real `parent_message_id`. Best-effort/
        // fire-and-forget: never blocks or fails the turn.
        const pending =
          b.kind === 'tool' && b.toolId
            ? subagentsByToolUse.get(b.toolId)
            : undefined;
        if (pending && messageId) {
          void this.subagentStore.upsert({
            id: pending.id,
            threadId,
            parentMessageId: messageId,
            toolUseId: pending.toolUseId,
            agentType: pending.agentType,
            model: pending.model,
            status: pending.status,
            startedAt: pending.startedAt,
            endedAt: pending.endedAt,
          });
        }
      }
      this.liveTurns.end(channel, jobId, lane); // fans turn_end + drops the in-flight buffer
    };

    return {
      emitPrompt: async (
        task: string,
        promptKey: string,
        extraMeta?: Record<string, unknown>,
      ) => {
        if (!task.trim()) return;
        await this.sink
          .appendBlockOnce(jobId, promptKey, {
            kind: 'agent_prompt',
            threadId,
            text: task,
            // `metaTag` (the lane's peel keys — codexReviewId / phaseId / autofixId) FIRST so the web routes
            // this block into the right sub-lane; `agentPrompt` + `promptKey` mark it + dedup it.
            meta: {
              ...(metaTag ?? {}),
              ...(extraMeta ?? {}),
              agentPrompt: true,
              promptKey,
            },
          })
          .catch((err) =>
            this.logger.warn(
              `emitPrompt failed for thread=${jobId} lane=${lane}: ${err}`,
            ),
          );
      },

      onEvent: (e: EngineEvent) => {
        if (closed) return;
        // Live push normally happens in RedisEngineRunner's independent `realtime` consumer group (driven by
        // the caller's `liveRoute`), so a slow/blocked transcript-accumulation path here never delays the
        // operator's live view. Faked/direct runners can opt into this fallback mirror.
        if (livePush) this.liveTurns.push(channel, jobId, e, lane);
        switch (e.kind) {
          case 'text': {
            // `parentToolUseId` (set only for subagent blocks) is stamped into meta so the web can peel
            // subagent activity out of the transcript into its own sub-page.
            if (!e.text.trim()) break;
            const meta = tagMeta(
              e.parentToolUseId
                ? { parentToolUseId: e.parentToolUseId }
                : undefined,
            );
            blocks.push({
              kind: 'chat',
              text: e.text,
              emittedAt: stamp(),
              ...(meta ? { meta } : {}),
            });
            break;
          }
          case 'thinking': {
            if (!e.text.trim()) break;
            const meta = tagMeta(
              e.parentToolUseId
                ? { parentToolUseId: e.parentToolUseId }
                : undefined,
            );
            blocks.push({
              kind: 'thinking',
              text: e.text,
              emittedAt: stamp(),
              ...(meta ? { meta } : {}),
            });
            break;
          }
          case 'tool_use': {
            const toolId = e.id || `tool-${blocks.length}`;
            blocks.push({
              kind: 'tool',
              toolId,
              done: false,
              meta: {
                // `metaTag` first so it can never clobber `id` (the web joins a subagent's child blocks
                // back to THIS spawning Task block via `meta.id` ↔ child `meta.parentToolUseId`).
                ...(metaTag ?? {}),
                id: toolId,
                name: e.name,
                input: e.input ?? null,
                result: null,
                isError: false,
                ...(e.parentToolUseId
                  ? { parentToolUseId: e.parentToolUseId }
                  : {}),
              },
              emittedAt: stamp(),
            });
            // A subagent SPAWN: a top-level `Task` tool_use (not itself a subagent's own nested Task call — a
            // subagent spawning a subagent is out of scope). Track it so its children can be tagged with
            // `subagent_id` and its `subagents` row created once its own anchor message is persisted (persistAll).
            if (e.name === 'Task' && !e.parentToolUseId) {
              const rawInput = e.input as
                | { subagent_type?: unknown }
                | undefined;
              const agentType =
                typeof rawInput?.subagent_type === 'string'
                  ? rawInput.subagent_type
                  : null;
              subagentsByToolUse.set(toolId, {
                id: randomUUID(),
                toolUseId: toolId,
                agentType,
                model: null,
                status: 'running',
                startedAt: new Date(),
                endedAt: null,
              });
            }
            break;
          }
          case 'tool_result': {
            // Pair with the newest still-open tool block (preserving interleaved order with text/thinking).
            for (let i = blocks.length - 1; i >= 0; i--) {
              const b = blocks[i];
              if (
                b.kind === 'tool' &&
                !b.done &&
                (b.toolId === e.id || !e.id)
              ) {
                b.done = true;
                b.meta = {
                  ...b.meta,
                  result: e.result ?? null,
                  isError: e.isError ?? false,
                  ...(e.isError && isInterruptAbortResult(e.result)
                    ? { superseded: true }
                    : {}),
                  ...(e.structuredPatch
                    ? { structuredPatch: e.structuredPatch }
                    : {}),
                };
                break;
              }
            }
            break;
          }
          case 'jit_injection': {
            // Match by `toolId` alone (NOT `!b.done`) — the (possibly async, up to 5s for
            // install-awareness) injection can arrive after `tool_result` already closed the block.
            for (let i = blocks.length - 1; i >= 0; i--) {
              const b = blocks[i];
              if (b.kind === 'tool' && b.toolId === e.id) {
                const prior =
                  (b.meta?.jitContext as JitInjection[] | undefined) ?? [];
                b.meta = {
                  ...b.meta,
                  jitContext: [...prior, { rule: e.rule, text: e.text }],
                };
                break;
              }
            }
            break;
          }
          case 'usage': {
            // A subagent-tagged occupancy (`parentToolUseId` set) — stamp the LATEST onto the subagent's
            // durable anchor (its spawning Task block, `meta.id === parentToolUseId`) so a reloaded card
            // still shows its context ring + real model after the turn ends. Untagged (main-agent) usage
            // stays live-only — the turn-end `turn_meta` already carries the orchestrator's occupancy.
            if (e.parentToolUseId) {
              const pendingUsage = subagentsByToolUse.get(e.parentToolUseId);
              if (pendingUsage && e.contextModel)
                pendingUsage.model = e.contextModel;
              for (let i = blocks.length - 1; i >= 0; i--) {
                const b = blocks[i];
                if (b.kind === 'tool' && b.meta?.id === e.parentToolUseId) {
                  b.meta = {
                    ...b.meta,
                    subContextTokens: e.contextTokens,
                    subContextLimit: e.contextLimit,
                    ...(e.contextModel
                      ? { subContextModel: e.contextModel }
                      : {}),
                  };
                  break;
                }
              }
            }
            break;
          }
          case 'bg_task': {
            // Settlement of a backgrounded Task SUBAGENT (not a bare bg Bash task, which carries no
            // `parentToolUseId`). 'stopped' (operator/host cancel) is folded into 'failed' — the subagents
            // lifecycle is a 3-state (running|done|failed), not a superset of the SDK's task states.
            if (
              e.parentToolUseId &&
              (e.status === 'completed' ||
                e.status === 'failed' ||
                e.status === 'stopped')
            ) {
              const pending = subagentsByToolUse.get(e.parentToolUseId);
              if (pending) {
                pending.status = e.status === 'completed' ? 'done' : 'failed';
                pending.endedAt = new Date();
              }
            }
            break;
          }
          case 'rate_limit': {
            // Harvest-only: fold this org's window straight into the usage snapshot. No durable block, no
            // extra live frame beyond the `liveTurns.push` above — the ring/popover reads it via `get()`.
            if (orgId) {
              void this.usage
                .applyHarvest(orgId, {
                  status: e.status,
                  resetsAt: e.resetsAt,
                  rateLimitType: e.rateLimitType,
                  utilization: e.utilization,
                  credentialId: e.credentialId,
                })
                .catch(() => undefined);
            }
            break;
          }
          case 'turn_debug': {
            if ('terminalReason' in e) terminalReason = e.terminalReason;
            if ('stopReason' in e) stopReason = e.stopReason;
            if (typeof e.streamClosedCount === 'number')
              streamClosedCount = e.streamClosedCount;
            break;
          }
          default:
            break; // session / result / *_delta — live-only, not part of the durable transcript
        }
      },

      finish: async (finalText?: string, turnMeta?: TurnEndMeta) => {
        if (closed) return;
        closed = true;
        // Fallback: a turn that emitted NO text block — keep the final summary so the reply isn't lost.
        if (
          !blocks.some((b) => b.kind === 'chat') &&
          finalText &&
          finalText.trim()
        ) {
          blocks.push({
            kind: 'chat',
            text: finalText.trim(),
            emittedAt: stamp(),
            ...(metaTag ? { meta: { ...metaTag } } : {}),
          });
        }
        // Per-turn accounting: a `turn_meta` block carrying usage/context occupancy plus engine diagnostics,
        // stamped LAST (the monotonic `stamp()` sorts it after every transcript block) so the web renders it
        // as the turn-end divider and keeps the values after the live Redis stream is reaped.
        if (
          turnMeta?.usage ||
          terminalReason !== undefined ||
          stopReason !== undefined ||
          streamClosedCount !== undefined
        ) {
          // Occupancy for the context ring: prefer the explicit top-level values the brain passes;
          // otherwise fall back to the occupancy already living on `usage` (populated by engine-core for
          // every Claude turn), resolving the window with the SAME per-model map the brain + analytics
          // use. This is what lets build/step/autofix (Claude) lanes render a ring without each finish
          // call site plumbing context. For a Codex lane (plan/master review) the SDK surfaces no per-call
          // occupancy — only a turn-CUMULATIVE `inputTokens` that sums the context re-sent on every internal
          // round-trip, so it balloons far past the window (a false 100% ring). But OpenAI prompt-caching
          // re-serves the repeated prior context as `cacheReadTokens` each round, so the uncached remainder
          // telescopes to ≈ the final round-trip's input = the real end-of-turn occupancy: `inputTokens −
          // cacheReadTokens`. (Degrades cleanly: a single-round-trip Codex turn has ~0 cache, so this ≈ its
          // one prompt.) Size it against the Codex window — this is what gives Codex lanes a truthful ring.
          const u = turnMeta?.usage;
          const codexOccupancy =
            u?.engine === 'codex'
              ? (u.contextTokens ??
                (u.inputTokens != null
                  ? Math.max(0, u.inputTokens - (u.cacheReadTokens ?? 0))
                  : null))
              : null;
          const ctxTokens =
            turnMeta?.contextTokens ?? u?.contextTokens ?? codexOccupancy;
          const ctxLimit =
            turnMeta?.contextLimit ??
            (ctxTokens != null
              ? resolveContextLimit(u?.contextModel ?? u?.model, u?.engine)
              : null);
          const ctxBreakdown = turnMeta?.contextBreakdown ?? u?.contextBreakdown;
          // How long the turn actually worked: `now − startedAt`, read from the still-live turn state (the
          // SAME clock that drove the "Atlas is working… 19m 24s" indicator, so the footer matches the last
          // reading). `snapshot` is valid here — `persistAll()` ends the live lane only afterwards; a turn
          // that pushed no events (no snapshot) simply carries no duration.
          const startedAt = this.liveTurns.snapshot(
            channel,
            jobId,
            lane,
          )?.startedAt;
          const workedMs =
            startedAt != null ? Math.max(0, Date.now() - startedAt) : undefined;
          blocks.push({
            kind: 'turn_meta',
            emittedAt: stamp(),
            meta: {
              ...(metaTag ?? {}),
              ...(u ? { usage: u as unknown as Record<string, unknown> } : {}),
              ...(turnMeta?.credentialId
                ? { credentialId: turnMeta.credentialId }
                : {}),
              ...(u
                ? { contextTokens: ctxTokens ?? null }
                : ctxTokens != null
                  ? { contextTokens: ctxTokens }
                  : {}),
              ...(ctxLimit != null ? { contextLimit: ctxLimit } : {}),
              ...(ctxBreakdown ? { contextBreakdown: ctxBreakdown } : {}),
              ...(terminalReason !== undefined ? { terminalReason } : {}),
              ...(stopReason !== undefined ? { stopReason } : {}),
              ...(streamClosedCount !== undefined ? { streamClosedCount } : {}),
              ...(workedMs != null ? { workedMs } : {}),
            },
          });
        }
        // Best-effort: a subagent still 'running' when the turn finishes naturally (no explicit bg_task
        // settlement observed) is treated as done — the engine holds the turn open until backgrounded
        // subagents settle, so by a natural `finish` they should already be settled; this is a defensive
        // fallback.
        for (const pending of subagentsByToolUse.values()) {
          if (pending.status === 'running') {
            pending.status = 'done';
            pending.endedAt = new Date();
          }
        }
        await persistAll();
      },

      abort: async () => {
        if (closed) return;
        closed = true;
        await persistAll();
      },

      discard: async () => {
        if (closed) return;
        closed = true;
        // End the live lane WITHOUT persisting the accumulated blocks — the caller is about to re-deliver
        // this turn in full (a benign stream abort on an at-least-once wake), so a flushed partial would
        // become a durable truncated half-message alongside the complete re-run.
        this.liveTurns.end(channel, jobId, lane);
      },

      bindTurnId: (turnId: string) => {
        persistTurnId = turnId;
      },
    };
  }
}
