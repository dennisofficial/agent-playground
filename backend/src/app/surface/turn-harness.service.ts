import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { EngineEvent, EngineUsage } from '../engine';
import { DB_CONNECTION } from '../persistence/database.module';
import { MessageEntity } from '../persistence/entities';
import { LiveTurnStore } from './live-turn-store';

/**
 * The durable destination for a turn's transcript blocks — a narrow port (just `appendBlock`) so a
 * consumer (the driver) can ride the shared {@link TurnHarnessFactory} WITHOUT pulling the whole brain
 * module (and the cycle that would create). Implemented by {@link MessageBlockSink}.
 */
export interface BlockSink {
  appendBlock(
    jobId: string,
    block: { kind: string; text?: string; meta?: Record<string, unknown> | null; createdAt?: Date },
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
    block: { kind: string; text?: string; meta?: Record<string, unknown> | null; createdAt?: Date },
  ): Promise<void> {
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: block.text ?? '',
        kind: block.kind,
        meta: block.meta ?? null,
        ...(block.createdAt ? { created_at: block.createdAt } : {}),
      }),
    );
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
   * Persist the accumulated transcript (+ a text fallback if none emitted), append a `turn_meta` block when
   * `turnMeta.usage` is present, then end the live lane.
   */
  finish(finalText?: string, turnMeta?: TurnEndMeta): Promise<void>;
  /** Persist whatever partials accumulated (no fallback) and end the live lane — for error/timeout paths. */
  abort(): Promise<void>;
}

export interface TurnHarnessOptions {
  /** The thread whose durable log + live stream this turn writes to. */
  jobId: string;
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
  ) {}

  create(options: TurnHarnessOptions): TurnHarness {
    const { jobId, channel } = options;
    const lane = options.lane ?? 'main';
    const metaTag = options.metaTag;

    type DurableBlock = {
      kind: string;
      text?: string;
      meta?: Record<string, unknown>;
      toolId?: string;
      done?: boolean;
      emittedAt: Date;
    };
    const blocks: DurableBlock[] = [];
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

    const persistAll = async (): Promise<void> => {
      for (const b of blocks) {
        await this.sink
          .appendBlock(jobId, {
            kind: b.kind,
            createdAt: b.emittedAt,
            ...(b.text != null ? { text: b.text } : {}),
            ...(b.meta ? { meta: b.meta } : {}),
          })
          .catch((err) => this.logger.warn(`appendBlock failed for thread=${jobId} lane=${lane}: ${err}`));
      }
      this.liveTurns.end(channel, jobId, lane); // fans turn_end + drops the in-flight buffer
    };

    return {
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
                break;
              }
            }
            break;
          }
          default:
            break; // session / result / *_delta — not part of the durable transcript
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
        // Per-turn accounting: a `turn_meta` block carrying usage + context occupancy, stamped LAST (the
        // monotonic `stamp()` sorts it after every transcript block) so the web renders it as the turn-end
        // divider and reads the latest one for the context ring. Only when usage is actually present.
        if (turnMeta?.usage) {
          blocks.push({
            kind: 'turn_meta',
            emittedAt: stamp(),
            meta: {
              ...(metaTag ?? {}),
              usage: turnMeta.usage as unknown as Record<string, unknown>,
              contextTokens: turnMeta.contextTokens ?? null,
              contextLimit: turnMeta.contextLimit ?? null,
            },
          });
        }
        await persistAll();
      },

      abort: async () => {
        if (closed) return;
        closed = true;
        await persistAll();
      },
    };
  }
}
