import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type QueryDeepPartialEntity, Repository } from 'typeorm';
import { type EngineEvent, type EngineUsage, resolveContextLimit } from '../engine';
import { foldTaskEvent } from '../driver/task-fold';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  MessageEntity,
  StageEntity,
  SubagentEntity,
  TaskEntity,
  type TaskItem,
  ThreadEntity,
} from '../persistence/entities';
import { LiveTurnStore } from './live-turn-store';
import { type TaskScope, taskScopeForLane } from './thread-registry';
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
    block: { kind: string; threadId: string; text?: string; meta?: Record<string, unknown> | null; createdAt?: Date },
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
    @InjectRepository(MessageEntity, DB_CONNECTION)
    private readonly messages: Repository<MessageEntity>,
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
      ...(block.createdAt ? { created_at: block.createdAt } : {}),
    };
    if (block.idemKey) {
      // ON CONFLICT DO NOTHING on the partial unique index `ux_messages_idem_key`: a repeat write of the same
      // `${turn_id}:${ordinal}` (two racing finishers, a redelivery) is a no-op instead of a duplicate row.
      const result = await this.messages
        .createQueryBuilder()
        .insert()
        .values({ ...row, idem_key: block.idemKey } as QueryDeepPartialEntity<MessageEntity>)
        .orIgnore()
        .execute();
      const insertedId = result.identifiers?.[0]?.id as string | undefined;
      if (insertedId) return insertedId;
      // A conflict (ON CONFLICT DO NOTHING) may not report an id — look up the existing row by its key.
      const existing = await this.messages.findOne({ where: { idem_key: block.idemKey }, select: { id: true } });
      return existing?.id;
    }
    const saved = await this.messages.save(this.messages.create(row));
    return saved.id;
  }

  async appendBlockOnce(
    jobId: string,
    promptKey: string,
    block: { kind: string; threadId: string; text?: string; meta?: Record<string, unknown> | null; createdAt?: Date },
  ): Promise<void> {
    // A job accumulates only a handful of `agent_prompt` rows (one per brain turn / review round / gate
    // iteration / lens), so loading them and filtering by `meta.promptKey` in JS is cheap and avoids
    // jsonb-containment SQL. If one already carries this key the emission is a no-op.
    const existing = await this.messages.find({
      where: { job_id: jobId, kind: 'agent_prompt' },
      select: { id: true, meta: true },
    });
    if (existing.some((m) => (m.meta as { promptKey?: string } | null)?.promptKey === promptKey)) {
      return;
    }
    // Stamp the key into meta so the dedup read above finds it on the NEXT call — the single source of
    // truth, whether the caller went through the harness's `emitPrompt` or wrote the block directly.
    await this.appendBlock(jobId, { ...block, threadId: block.threadId, meta: { ...(block.meta ?? {}), promptKey } });
  }
}

/**
 * The destination for a `TaskCreate`/`TaskUpdate` tool event — a narrow port (mirrors {@link BlockSink})
 * so the harness can fold LLM-authored task-list events into the owning entity's tasks jsonb column
 * WITHOUT depending on the driver module (and the cycle that would create, since the driver already
 * depends on {@link TurnHarnessFactory}). Implemented by {@link EntityTaskEventSink}.
 */
export interface TaskEventSink {
  applyTaskEvent(
    scope: TaskScope,
    toolName: string,
    input: Record<string, unknown>,
    /** The tool's RAW result — the SDK task tools return a plain string ("Task #8 created…"). */
    result: unknown,
  ): Promise<void>;
}

/** DI token for {@link TaskEventSink}. */
export const TASK_EVENT_SINK = Symbol('TASK_EVENT_SINK');

/**
 * One scope's in-memory fold snapshot — the SDK-id-space {@link TaskItem} list `foldTaskEvent` operates
 * on (byte-identical to the old jsonb blob's shape), plus the mapping from an SDK-authored task id (the
 * `#8` parsed out of `"Task #8 created…"`, scoped to ONE engine session) to the durable `tasks` row it
 * became. The SDK's own task-tool id space is only unique WITHIN a session — reconciling it against a
 * real table (whose PK is a DB-generated uuid, see `TaskEntity.id`) needs this side-map so a later
 * `TaskUpdate({taskId: "8"})` in the SAME session finds the row `TaskCreate` produced. Rows preloaded
 * from the DB (the stage's tasks from an earlier session, e.g. after rotation or a process restart) are
 * seeded with an identity mapping (their own row id doubles as its "sdk id") — a genuine SDK id never
 * collides with a uuid, so this is a safe, allocation-free default.
 */
interface TaskFoldCache {
  items: TaskItem[];
  rowIdBySdkId: Map<string, string>;
}

/**
 * The default {@link TaskEventSink} — folds `TaskCreate`/`TaskUpdate` tool events (via the existing
 * `foldTaskEvent`, unchanged) into an in-memory per-scope snapshot, then reconciles that snapshot against
 * the stage's durable `tasks` rows (d6) — replacing the old direct read-modify-write of the
 * `threads.tasks` / `jobs.main_tasks` jsonb blobs those columns used to hold.
 */
@Injectable()
export class EntityTaskEventSink implements TaskEventSink {
  constructor(
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @InjectRepository(StageEntity, DB_CONNECTION)
    private readonly stages: Repository<StageEntity>,
    @InjectRepository(TaskEntity, DB_CONNECTION)
    private readonly tasks: Repository<TaskEntity>,
  ) {}

  /**
   * Per-scope FIFO chain. The harness fires task events fire-and-forget, and a batch of task calls in one
   * turn ("deleted · deleted · deleted") lands as near-simultaneous tool_results — unserialized, their
   * read-modify-writes clobber each other (a LOST UPDATE: two folds read the same snapshot, the second
   * write erases the first's change; live-observed as "deleted tasks still showing"). Chaining per scope
   * key preserves arrival order and makes each fold read its predecessor's write.
   */
  private readonly chains = new Map<string, Promise<void>>();

  /** The in-memory fold snapshot per scope key (see {@link TaskFoldCache}) — lazily seeded from the
   *  stage's current `tasks` rows on this scope's first event since process start. */
  private readonly cache = new Map<string, TaskFoldCache>();

  applyTaskEvent(
    scope: TaskScope,
    toolName: string,
    input: Record<string, unknown>,
    result: unknown,
  ): Promise<void> {
    const key = `${scope.kind}:${scope.id}`;
    const run = (this.chains.get(key) ?? Promise.resolve()).then(() =>
      this.apply(key, scope, toolName, input, result),
    );
    // Keep the chain alive past a rejection, and drop the map entry once this tail settles (no growth).
    const tail = run.catch(() => undefined).finally(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    this.chains.set(key, tail);
    return run;
  }

  /** Resolve the stage that owns this scope's shared checklist: a `thread` scope's own `stage_id`, or a
   *  `main` scope's job's `planning` stage (mirrors `DriverStoreService.planningThreadId`'s lookup). */
  private async resolveStageId(scope: TaskScope): Promise<{ stageId: string; orgId: string } | null> {
    if (scope.kind === 'thread') {
      const thread = await this.threads.findOne({
        where: { id: scope.id },
        select: { id: true, stage_id: true, org_id: true },
      });
      return thread ? { stageId: thread.stage_id, orgId: thread.org_id } : null;
    }
    // scope.kind === 'main' — the job's planning stage owns the brain's own checklist.
    const stage = await this.stages.findOne({
      where: { job_id: scope.id, kind: 'planning' },
      order: { ordinal: 'ASC' },
      select: { id: true, org_id: true },
    });
    return stage ? { stageId: stage.id, orgId: stage.org_id } : null;
  }

  private async seedCache(key: string, stageId: string): Promise<TaskFoldCache> {
    const existing = this.cache.get(key);
    if (existing) return existing;
    const rows = await this.tasks.find({ where: { stage_id: stageId }, order: { ordinal: 'ASC' } });
    const rowIdBySdkId = new Map<string, string>();
    const items = rows.map((row) => {
      rowIdBySdkId.set(row.id, row.id); // identity seed — see TaskFoldCache's doc comment
      return toTaskItem(row);
    });
    const seeded: TaskFoldCache = { items, rowIdBySdkId };
    this.cache.set(key, seeded);
    return seeded;
  }

  private async apply(
    key: string,
    scope: TaskScope,
    toolName: string,
    input: Record<string, unknown>,
    result: unknown,
  ): Promise<void> {
    const resolved = await this.resolveStageId(scope);
    if (!resolved) return;
    const { stageId, orgId } = resolved;
    const before = await this.seedCache(key, stageId);
    const after = foldTaskEvent(before.items, toolName, input, result);
    if (after === before.items) return; // a read-only task tool (TaskList/TaskGet) — no-op fold

    const rowIdBySdkId = new Map(before.rowIdBySdkId);
    const beforeById = new Map(before.items.map((t) => [t.id, t]));
    const afterIds = new Set(after.map((t) => t.id));

    // Resolve an item's DB row id (blockedBy edges reference OTHER items by their sdk/pseudo id) — an
    // edge that doesn't resolve within this scope's known rows is dropped rather than left dangling.
    const resolveRowId = (sdkId: string): string | undefined => rowIdBySdkId.get(sdkId);

    // Deletions: an id that fell out of the fold is gone from the checklist (foldTaskEvent's `deleted`
    // semantics) — remove its row.
    for (const prev of before.items) {
      if (afterIds.has(prev.id)) continue;
      const rowId = resolveRowId(prev.id);
      if (rowId) await this.tasks.delete({ id: rowId });
      rowIdBySdkId.delete(prev.id);
    }

    // Creates + updates, in the fold's own order (its ordinal). Only look up the stage's current max
    // ordinal when there's at least one genuine create to gap-number — a pure update/delete fold never
    // touches it.
    const hasCreate = after.some((item) => !resolveRowId(item.id));
    let ordinal = hasCreate ? await this.maxTaskOrdinal(stageId) : 0;
    for (const item of after) {
      const blockedBy = (item.blockedBy ?? [])
        .map((b) => resolveRowId(b))
        .filter((id): id is string => Boolean(id));
      const prev = beforeById.get(item.id);
      const rowId = resolveRowId(item.id);
      if (!rowId) {
        ordinal += 10;
        const created = await this.tasks.save(
          this.tasks.create({
            stage_id: stageId,
            org_id: orgId,
            ordinal,
            title: item.subject,
            brief: item.description ?? null,
            active_form: item.activeForm ?? null,
            status: item.status,
            blocked_by: blockedBy,
          }),
        );
        rowIdBySdkId.set(item.id, created.id);
        continue;
      }
      if (
        !prev ||
        prev.subject !== item.subject ||
        prev.status !== item.status ||
        prev.description !== item.description ||
        prev.activeForm !== item.activeForm ||
        JSON.stringify(prev.blockedBy ?? []) !== JSON.stringify(blockedBy)
      ) {
        await this.tasks.update(
          { id: rowId },
          {
            title: item.subject,
            brief: item.description ?? null,
            active_form: item.activeForm ?? null,
            status: item.status,
            blocked_by: blockedBy,
          },
        );
      }
    }

    this.cache.set(key, { items: after, rowIdBySdkId });
  }

  private async maxTaskOrdinal(stageId: string): Promise<number> {
    const row = await this.tasks
      .createQueryBuilder('t')
      .select('MAX(t.ordinal)', 'max')
      .where('t.stage_id = :stageId', { stageId })
      .getRawOne<{ max: number | null }>();
    return row?.max ?? 0;
  }
}

/** Map a stage-owned {@link TaskEntity} row back to the `TaskItem` wire/domain shape (mirrors
 *  `DriverStoreService`'s own copy — kept local to avoid a cross-module dependency on the driver). */
function toTaskItem(row: TaskEntity): TaskItem {
  return {
    id: row.id,
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
  emitPrompt(task: string, promptKey: string, extraMeta?: Record<string, unknown>): Promise<void>;
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
}

/**
 * THE SHARED TRANSCRIPT SPINE.
 *
 * Lifted verbatim from the brain's former `makeTurnStreamer` so EVERY engine turn — the thread brain, a
 * build phase, a nested subagent — converts its engine event stream into the SAME two outputs:
 *   (a) a LIVE, resumable push to {@link LiveTurnStore} (token deltas + thinking + tool calls/results), and
 *   (b) the AUTHORITATIVE durable blocks (`chat`/`thinking`/`tool`), persisted at turn END via {@link BlockSink}.
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
    @Inject(TASK_EVENT_SINK) private readonly taskSink: TaskEventSink,
    private readonly usage: OauthUsageService,
    @Inject(SUBAGENT_STORE) private readonly subagentStore: SubagentStore = NOOP_SUBAGENT_STORE,
  ) {}

  /**
   * Resolve which entity's tasks column a `TaskCreate`/`TaskUpdate` call on this harness belongs to, from
   * the STABLE lane it rides. Delegates to the {@link THREAD_REGISTRY} single source of truth.
   */
  private taskScopeFor(lane: string, jobId: string): TaskScope | null {
    return taskScopeForLane(lane, jobId);
  }

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
    const tagMeta = (extra?: Record<string, unknown>): Record<string, unknown> | undefined => {
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
        const subagentId = parentToolUseId ? subagentsByToolUse.get(parentToolUseId)?.id : undefined;
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
            this.logger.warn(`appendBlock failed for thread=${jobId} lane=${lane}: ${err}`);
            return undefined;
          });

        // This block IS a subagent's spawning anchor (a tracked Task tool_use) — now that its own message
        // row is persisted, upsert the `subagents` row with a real `parent_message_id`. Best-effort/
        // fire-and-forget: never blocks or fails the turn.
        const pending = b.kind === 'tool' && b.toolId ? subagentsByToolUse.get(b.toolId) : undefined;
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
      emitPrompt: async (task: string, promptKey: string, extraMeta?: Record<string, unknown>) => {
        if (!task.trim()) return;
        await this.sink
          .appendBlockOnce(jobId, promptKey, {
            kind: 'agent_prompt',
            threadId,
            text: task,
            // `metaTag` (the lane's peel keys — codexReviewId / phaseId / autofixId) FIRST so the web routes
            // this block into the right sub-lane; `agentPrompt` + `promptKey` mark it + dedup it.
            meta: { ...(metaTag ?? {}), ...(extraMeta ?? {}), agentPrompt: true, promptKey },
          })
          .catch((err) =>
            this.logger.warn(`emitPrompt failed for thread=${jobId} lane=${lane}: ${err}`),
          );
      },

      onEvent: (e: EngineEvent) => {
        if (closed) return;
        // LIVE + RESUMABLE: the store fans the frame AND holds the cumulative turn for snapshot-on-connect.
        this.liveTurns.push(channel, jobId, e, lane);
        switch (e.kind) {
          case 'text': {
            // `parentToolUseId` (set only for subagent blocks) is stamped into meta so the web can peel
            // subagent activity out of the transcript into its own sub-page.
            if (!e.text.trim()) break;
            const meta = tagMeta(e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : undefined);
            blocks.push({ kind: 'chat', text: e.text, emittedAt: stamp(), ...(meta ? { meta } : {}) });
            break;
          }
          case 'thinking': {
            if (!e.text.trim()) break;
            const meta = tagMeta(e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : undefined);
            blocks.push({ kind: 'thinking', text: e.text, emittedAt: stamp(), ...(meta ? { meta } : {}) });
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
                ...(e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : {}),
              },
              emittedAt: stamp(),
            });
            // A subagent SPAWN: a top-level `Task` tool_use (not itself a subagent's own nested Task call — a
            // subagent spawning a subagent is out of scope). Track it so its children can be tagged with
            // `subagent_id` and its `subagents` row created once its own anchor message is persisted (persistAll).
            if (e.name === 'Task' && !e.parentToolUseId) {
              const rawInput = e.input as { subagent_type?: unknown } | undefined;
              const agentType = typeof rawInput?.subagent_type === 'string' ? rawInput.subagent_type : null;
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
              if (b.kind === 'tool' && !b.done && (b.toolId === e.id || !e.id)) {
                b.done = true;
                b.meta = {
                  ...b.meta,
                  result: e.result ?? null,
                  isError: e.isError ?? false,
                  ...(e.structuredPatch ? { structuredPatch: e.structuredPatch } : {}),
                };
                // LLM-authored task list: fold TaskCreate/TaskUpdate into the owning thread's/job's `tasks`
                // column. Excludes a writer subagent's own calls (`parentToolUseId` set) — only the
                // orchestrating session's task list is tracked. Best-effort: never blocks/sinks the turn.
                const toolName = typeof b.meta.name === 'string' ? b.meta.name.toLowerCase() : '';
                if (
                  (toolName === 'taskcreate' || toolName === 'taskupdate') &&
                  !b.meta.parentToolUseId
                ) {
                  const scope = this.taskScopeFor(lane, jobId);
                  if (scope) {
                    const input = (b.meta.input ?? {}) as Record<string, unknown>;
                    void this.taskSink
                      .applyTaskEvent(scope, toolName, input, e.result ?? null)
                      .catch((err) => this.logger.warn(`task-event apply failed (ignored): ${err}`));
                  }
                }
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
              if (pendingUsage && e.contextModel) pendingUsage.model = e.contextModel;
              for (let i = blocks.length - 1; i >= 0; i--) {
                const b = blocks[i];
                if (b.kind === 'tool' && b.meta?.id === e.parentToolUseId) {
                  b.meta = {
                    ...b.meta,
                    subContextTokens: e.contextTokens,
                    subContextLimit: e.contextLimit,
                    ...(e.contextModel ? { subContextModel: e.contextModel } : {}),
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
            if (e.parentToolUseId && (e.status === 'completed' || e.status === 'failed' || e.status === 'stopped')) {
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
            if (typeof e.streamClosedCount === 'number') streamClosedCount = e.streamClosedCount;
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
        if (!blocks.some((b) => b.kind === 'chat') && finalText && finalText.trim()) {
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
          const ctxTokens = turnMeta?.contextTokens ?? u?.contextTokens ?? codexOccupancy;
          const ctxLimit =
            turnMeta?.contextLimit ??
            (ctxTokens != null ? resolveContextLimit(u?.contextModel ?? u?.model, u?.engine) : null);
          // How long the turn actually worked: `now − startedAt`, read from the still-live turn state (the
          // SAME clock that drove the "Atlas is working… 19m 24s" indicator, so the footer matches the last
          // reading). `snapshot` is valid here — `persistAll()` ends the live lane only afterwards; a turn
          // that pushed no events (no snapshot) simply carries no duration.
          const startedAt = this.liveTurns.snapshot(channel, jobId, lane)?.startedAt;
          const workedMs = startedAt != null ? Math.max(0, Date.now() - startedAt) : undefined;
          blocks.push({
            kind: 'turn_meta',
            emittedAt: stamp(),
            meta: {
              ...(metaTag ?? {}),
              ...(u ? { usage: u as unknown as Record<string, unknown> } : {}),
              ...(u ? { contextTokens: ctxTokens ?? null } : ctxTokens != null ? { contextTokens: ctxTokens } : {}),
              ...(ctxLimit != null ? { contextLimit: ctxLimit } : {}),
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
