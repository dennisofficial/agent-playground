import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  type ContextBreakdown,
  type EngineEvent,
  type EngineUsage,
  type JitInjection,
  resolveContextLimit,
} from '@shared/engine';
import { randomUUID } from 'node:crypto';
import { type QueryDeepPartialEntity, Repository } from 'typeorm';
import { isInterruptAbortResult } from '../brain/session-transcript';
import { AppVersionService } from '../cluster/app-version.service';
import { OauthUsageService } from '../onboarding/oauth-usage.service';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  SubagentEntity,
  TaskEntity,
  type TaskItem,
  ThreadEntity,
  ThreadGroupEntity,
  TranscriptMessageEntity,
} from '../persistence/entities';
import { LiveTurnStore } from './live-turn-store';
import { applyEdge, hasBlockedByInput, inverseEdgeOps, isStr, mergeBlockedBy } from './task-edges';
import { type TaskScope } from './thread-registry';

export interface BlockSink {
  appendBlock(
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
  ): Promise<string | undefined>;
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
  /** Re-stamp a pure-UI notice row's `order_at` once the turn it was deferred behind has flushed — see
   *  `LiveTurnStore.registerPostTurnRow`. */
  stampOrderAt(rowId: string, at: Date): Promise<void>;
}

export const BLOCK_SINK = Symbol('BLOCK_SINK');

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
      const existing = await this.messages.findOne({
        where: { idem_key: block.idemKey },
        select: { id: true },
      });
      return existing?.id;
    }
    const saved = await this.messages.save(this.messages.create(row));
    return saved.id;
  }

  async stampOrderAt(rowId: string, at: Date): Promise<void> {
    await this.messages.update(rowId, { order_at: at });
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
    const existing = await this.messages.find({
      where: { job_id: jobId, kind: 'agent_prompt' },
      select: { id: true, meta: true },
    });
    if (existing.some((m) => (m.meta as { promptKey?: string } | null)?.promptKey === promptKey)) {
      return;
    }
    await this.appendBlock(jobId, {
      ...block,
      threadId: block.threadId,
      meta: { ...(block.meta ?? {}), promptKey },
    });
  }
}

export interface TaskEventSink {
  createTask(scope: TaskScope, input: Record<string, unknown>): Promise<{ id: string }>;
  updateTask(
    scope: TaskScope,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }>;
  readTasks(scope: TaskScope): Promise<TaskItem[]>;
}

export const TASK_EVENT_SINK = Symbol('TASK_EVENT_SINK');

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

  private readonly chains = new Map<string, Promise<unknown>>();

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

  async createTask(scope: TaskScope, input: Record<string, unknown>): Promise<{ id: string }> {
    return this.chain(scope, async () => {
      const resolved = await this.resolveThreadGroupId(scope);
      if (!resolved) throw new Error(`task scope not found: ${scope.kind}:${scope.id}`);
      const { threadGroupId, orgId } = resolved;
      const ordinal = (await this.maxTaskOrdinal(threadGroupId)) + 1;
      const blockedBy = await this.validBlockedBy(threadGroupId, mergeBlockedBy([], input));
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
      const ordinal = Number(String(input.taskId ?? '').trim());
      if (!Number.isInteger(ordinal))
        return { ok: false, error: `invalid taskId ${String(input.taskId)}` };
      const row = await this.tasks.findOne({
        where: { ordinal, thread_group_id: threadGroupId },
      });
      if (!row) return { ok: false, error: `task ${ordinal} not found` };

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
      if (Object.keys(patch).length) await this.tasks.update({ id: row.id }, patch);

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
    const threadGroup = await this.threadGroups.findOne({
      where: { job_id: scope.id, kind: 'planning' },
      order: { ordinal: 'ASC' },
      select: { id: true, org_id: true },
    });
    return threadGroup ? { threadGroupId: threadGroup.id, orgId: threadGroup.org_id } : null;
  }

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

  private async removeBlockedByReference(threadGroupId: string, sourceId: string): Promise<void> {
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

function mapTaskStatus(raw: unknown): 'pending' | 'in_progress' | 'completed' | null {
  return raw === 'pending' || raw === 'in_progress' || raw === 'completed' ? raw : null;
}

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

export interface SubagentStore {
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

export const SUBAGENT_STORE = Symbol('SUBAGENT_STORE');

const NOOP_SUBAGENT_STORE: SubagentStore = { upsert: async () => undefined };

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

export interface TurnEndMeta {
  usage?: EngineUsage;
  contextTokens?: number | null;
  contextLimit?: number;
  contextBreakdown?: ContextBreakdown | null;
  credentialId?: string | null;
}

export interface TurnHarness {
  onEvent(e: EngineEvent): void;
  emitPrompt(task: string, promptKey: string, extraMeta?: Record<string, unknown>): Promise<void>;
  finish(finalText?: string, turnMeta?: TurnEndMeta): Promise<void>;
  abort(): Promise<void>;
  discard(): Promise<void>;
  bindTurnId(turnId: string): void;
}

export interface TurnHarnessOptions {
  jobId: string;
  threadId: string;
  orgId?: string;
  channel: string;
  lane?: string;
  metaTag?: Record<string, unknown>;
  turnId?: string;
  livePush?: boolean;
}

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
    const stamp = (): Date => {
      lastEmitMs = Math.max(Date.now(), lastEmitMs + 1);
      return new Date(lastEmitMs);
    };
    const tagMeta = (extra?: Record<string, unknown>): Record<string, unknown> | undefined => {
      const merged = { ...(metaTag ?? {}), ...(extra ?? {}) };
      return Object.keys(merged).length > 0 ? merged : undefined;
    };

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
            this.logger.warn(`appendBlock failed for thread=${jobId} lane=${lane}: ${err}`);
            return undefined;
          });

        const pending =
          b.kind === 'tool' && b.toolId ? subagentsByToolUse.get(b.toolId) : undefined;
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
      // Flush any pure-UI notices deferred behind this turn (LiveTurnStore.registerPostTurnRow) — stamp
      // each just after the turn's last block so it renders below the reply instead of at its post time.
      const maxEmit = blocks.length
        ? Math.max(...blocks.map((b) => b.emittedAt.getTime()))
        : Date.now();
      const pending = this.liveTurns.takePendingOrder(channel, jobId, lane);
      for (let i = 0; i < pending.length; i++) {
        await this.sink
          .stampOrderAt(pending[i], new Date(maxEmit + 1 + i))
          .catch((err) => {
            this.logger.warn(
              `stampOrderAt failed for thread=${jobId} lane=${lane}: ${err}`,
            );
          });
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
            meta: {
              ...(metaTag ?? {}),
              ...(extraMeta ?? {}),
              agentPrompt: true,
              promptKey,
            },
          })
          .catch((err) =>
            this.logger.warn(`emitPrompt failed for thread=${jobId} lane=${lane}: ${err}`),
          );
      },

      onEvent: (e: EngineEvent) => {
        if (closed) return;
        if (livePush) this.liveTurns.push(channel, jobId, e, lane);
        switch (e.kind) {
          case 'text': {
            if (!e.text.trim()) break;
            const meta = tagMeta(
              e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : undefined,
            );
            blocks.push({
              kind: 'chat',
              text: e.text,
              emittedAt: stamp(),
              ...(meta ? { meta } : {}),
            });
            break;
          }
          case 'user_text': {
            if (!e.text.trim()) break;
            const meta = tagMeta({ parentToolUseId: e.parentToolUseId });
            blocks.push({
              kind: 'user',
              text: e.text,
              emittedAt: stamp(),
              ...(meta ? { meta } : {}),
            });
            break;
          }
          case 'thinking': {
            if (!e.text.trim()) break;
            const meta = tagMeta(
              e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : undefined,
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
            if (e.name === 'Task' && !e.parentToolUseId) {
              const rawInput = e.input as { subagent_type?: unknown } | undefined;
              const agentType =
                typeof rawInput?.subagent_type === 'string' ? rawInput.subagent_type : null;
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
            for (let i = blocks.length - 1; i >= 0; i--) {
              const b = blocks[i];
              if (b.kind === 'tool' && !b.done && (b.toolId === e.id || !e.id)) {
                b.done = true;
                b.meta = {
                  ...b.meta,
                  result: e.result ?? null,
                  isError: e.isError ?? false,
                  ...(e.isError && isInterruptAbortResult(e.result) ? { superseded: true } : {}),
                  ...(e.structuredPatch ? { structuredPatch: e.structuredPatch } : {}),
                };
                break;
              }
            }
            break;
          }
          case 'jit_injection': {
            for (let i = blocks.length - 1; i >= 0; i--) {
              const b = blocks[i];
              if (b.kind === 'tool' && b.toolId === e.id) {
                const prior = (b.meta?.jitContext as JitInjection[] | undefined) ?? [];
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
            if (
              e.parentToolUseId &&
              (e.status === 'completed' || e.status === 'failed' || e.status === 'stopped')
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
        if (!blocks.some((b) => b.kind === 'chat') && finalText && finalText.trim()) {
          blocks.push({
            kind: 'chat',
            text: finalText.trim(),
            emittedAt: stamp(),
            ...(metaTag ? { meta: { ...metaTag } } : {}),
          });
        }
        if (
          turnMeta?.usage ||
          terminalReason !== undefined ||
          stopReason !== undefined ||
          streamClosedCount !== undefined
        ) {
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
            (ctxTokens != null
              ? resolveContextLimit(u?.contextModel ?? u?.model, u?.engine)
              : null);
          const ctxBreakdown = turnMeta?.contextBreakdown ?? u?.contextBreakdown;
          const startedAt = this.liveTurns.snapshot(channel, jobId, lane)?.startedAt;
          const workedMs = startedAt != null ? Math.max(0, Date.now() - startedAt) : undefined;
          blocks.push({
            kind: 'turn_meta',
            emittedAt: stamp(),
            meta: {
              ...(metaTag ?? {}),
              ...(u ? { usage: u as unknown as Record<string, unknown> } : {}),
              ...(turnMeta?.credentialId ? { credentialId: turnMeta.credentialId } : {}),
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
        this.liveTurns.end(channel, jobId, lane);
      },

      bindTurnId: (turnId: string) => {
        persistTurnId = turnId;
      },
    };
  }
}
