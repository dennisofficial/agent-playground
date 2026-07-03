import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

/**
 * One assembled block of an in-flight turn — the SAME shape the web client renders (so a snapshot maps
 * with no translation). `text`/`thinking` carry `text`; `tool` carries `name`/`input`/`result`/`isError`
 * (+ `toolId` for pairing a result to its call).
 */
export interface LiveTurnBlock {
  kind: 'text' | 'thinking' | 'tool';
  key: string;
  text?: string;
  name?: string;
  toolId?: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
  /** Edit/MultiEdit only: structured patch (real file offsets) for an accurate diff gutter on reconnect. */
  structuredPatch?: unknown;
  done: boolean;
  /**
   * Set only for SUBAGENT blocks (the spawning Task tool_use id). Carried through the snapshot so a
   * mid-turn reconnect preserves subagent ownership — the web peels subagent activity out by this. Also
   * partitions the delta-merge so a subagent's forwarded text never appends onto the brain's open block.
   */
  parentToolUseId?: string;
}

/** The cumulative state of one in-flight turn (a `(jobId, lane)` pair) — the RESUMABLE snapshot. */
export interface LiveTurnSnapshot {
  jobId: string;
  /** `'main'` = the brain turn; `'thread:<threadId>'` = a build turn. The client routes blocks by lane. */
  lane: string;
  blocks: LiveTurnBlock[];
  active: boolean;
  /** The highest frame `seq` reflected in this snapshot (the client dedupes deltas against it). */
  seq: number;
  /** Epoch ms when this turn's live state was first created — the "working since" clock for the elapsed timer. */
  startedAt: number;
}

/** A frame fanned to SSE: an engine delta, a `{kind:'snapshot'}`, or a `{kind:'turn_end'}` — all seq'd. */
export interface LiveStreamFrame {
  channel: string;
  jobId: string;
  lane: string;
  seq: number;
  event: unknown;
}

interface TurnState {
  jobId: string;
  lane: string;
  blocks: LiveTurnBlock[];
  active: boolean;
  lastSeq: number;
  startedAt: number;
}

/** The default lane — the thread brain's conversational turn. */
export const MAIN_LANE = 'main';

/**
 * THE RESUMABLE/DURABLE LIVE-STREAM BUFFER.
 *
 * A thread is a web wrapper over an in-sandbox Claude Code session. The session (the PRODUCER) runs to
 * completion independent of any connected client (it's driven by the chat intake, not the SSE). This
 * store is the in-memory buffer that makes the stream RESUMABLE: it accumulates each in-flight turn's
 * cumulative block state as the brain pushes engine events, and exposes a SNAPSHOT so a client that
 * connects mid-turn (first load, refresh, navigate-away-and-back, or a network blip) catches up to the
 * current state and then continues with live deltas — instead of seeing nothing until the turn ends.
 *
 * Mirrors the rs-crm-app email-summary pattern (their Redis job-progress buffer → this in-memory store,
 * since Atlas is single-process). Durability split:
 *   - DURABLE history (survives restart): completed blocks → Postgres `messages` (the brain persists them).
 *   - RESUMABLE live turn (survives client disconnect within the process): this store + snapshot-on-connect.
 *   - A server restart mid-turn: the detached engine keeps running against its Redis streams, and the
 *     boot re-attach (ADR 0001) replays the durable event log from the start through the turn harness —
 *     which REBUILDS this store's cumulative state, so a reconnecting client recovers the full live turn.
 *
 * `seq` is a process-global monotonic counter stamped on every frame; the client keeps the max it has
 * applied and ignores any delta with `seq <= snapshot.seq` — so the snapshot-then-live merge has no race.
 */
@Injectable()
export class LiveTurnStore {
  private readonly subject = new Subject<LiveStreamFrame>();
  /** channel (repoId) → `${jobId}::${lane}` → cumulative in-flight turn. */
  private readonly turns = new Map<string, Map<string, TurnState>>();
  private seq = 0;
  private blockSeq = 0;

  /** The live frame feed — the SSE controller fans this to web clients (filtered by repo). */
  get stream$(): Observable<LiveStreamFrame> {
    return this.subject.asObservable();
  }

  /** Apply one engine event to a turn's in-flight state (cumulative) AND fan it live with a fresh seq. */
  push(
    channel: string,
    jobId: string,
    event: { kind: string; [k: string]: unknown },
    lane: string = MAIN_LANE,
  ): void {
    const isNew = !this.turns.get(channel)?.get(this.key(jobId, lane));
    const state = this.ensure(channel, jobId, lane);
    // The FIRST event of a turn fans an explicit `turn_start` (carrying the "working since" clock) so the
    // client can drive an accurate elapsed timer + flip its working indicator on authoritatively.
    if (isNew) {
      const startSeq = ++this.seq;
      state.lastSeq = startSeq;
      this.subject.next({
        channel,
        jobId,
        lane,
        seq: startSeq,
        event: { kind: 'turn_start', startedAt: state.startedAt },
      });
    }
    this.applyToState(state, event);
    const seq = ++this.seq;
    state.lastSeq = seq;
    this.subject.next({ channel, jobId, lane, seq, event });
  }

  /** End a turn: fan a `turn_end` marker (so the client reconciles against the durable log), then drop it. */
  end(channel: string, jobId: string, lane: string = MAIN_LANE): void {
    const seq = ++this.seq;
    this.subject.next({ channel, jobId, lane, seq, event: { kind: 'turn_end' } });
    this.turns.get(channel)?.delete(this.key(jobId, lane));
  }

  /** The current cumulative snapshot for one turn lane (or null when no turn is in flight). */
  snapshot(channel: string, jobId: string, lane: string = MAIN_LANE): LiveTurnSnapshot | null {
    const state = this.turns.get(channel)?.get(this.key(jobId, lane));
    if (!state) return null;
    return {
      jobId,
      lane,
      blocks: state.blocks,
      active: state.active,
      seq: state.lastSeq,
      startedAt: state.startedAt,
    };
  }

  /** Every in-flight turn lane for a repo — replayed to a client the moment its SSE connects. */
  snapshotsForRepo(channel: string): LiveTurnSnapshot[] {
    const m = this.turns.get(channel);
    if (!m) return [];
    return [...m.values()].map((s) => ({
      jobId: s.jobId,
      lane: s.lane,
      blocks: s.blocks,
      active: s.active,
      seq: s.lastSeq,
      startedAt: s.startedAt,
    }));
  }

  private key(jobId: string, lane: string): string {
    return `${jobId}::${lane}`;
  }

  private ensure(channel: string, jobId: string, lane: string): TurnState {
    let m = this.turns.get(channel);
    if (!m) {
      m = new Map();
      this.turns.set(channel, m);
    }
    const k = this.key(jobId, lane);
    let s = m.get(k);
    if (!s) {
      s = { jobId, lane, blocks: [], active: true, lastSeq: 0, startedAt: Date.now() };
      m.set(k, s);
    }
    s.active = true;
    return s;
  }

  /** Assemble cumulative blocks from engine events — identical logic to the web `job-stream` store. */
  private applyToState(state: TurnState, ev: { kind: string; [k: string]: unknown }): void {
    const blocks = state.blocks;
    const last = blocks[blocks.length - 1];
    const text = typeof ev['text'] === 'string' ? (ev['text'] as string) : '';
    // Only merge into the open block when it belongs to the SAME author (brain vs a given subagent), so a
    // subagent's forwarded text never appends onto the brain's open text block (or another subagent's).
    const pid = typeof ev['parentToolUseId'] === 'string' ? (ev['parentToolUseId'] as string) : undefined;
    const sameAuthor = (b: LiveTurnBlock | undefined): boolean => !!b && b.parentToolUseId === pid;
    // Finalize the most-recent still-open block of this kind+author. Interleaved thinking (auto-enabled by
    // adaptive thinking) means a turn can have TWO open delta blocks at once — an open `thinking` and an open
    // `text` — so the authoritative block we're closing is NOT necessarily `last`. Checking only `last` here
    // pushed a duplicate instead of merging (the "double stream" bug). Scan back for the matching open block.
    const finalizeOpen = (kind: 'text' | 'thinking'): boolean => {
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b.kind === kind && !b.done && b.parentToolUseId === pid) {
          b.text = text;
          b.done = true;
          return true;
        }
      }
      return false;
    };
    switch (ev.kind) {
      case 'text_delta':
        if (last && last.kind === 'text' && !last.done && sameAuthor(last)) last.text = (last.text ?? '') + text;
        else blocks.push({ kind: 'text', key: `b${this.blockSeq++}`, text, done: false, parentToolUseId: pid });
        break;
      case 'text':
        if (!finalizeOpen('text'))
          blocks.push({ kind: 'text', key: `b${this.blockSeq++}`, text, done: true, parentToolUseId: pid });
        break;
      case 'thinking_delta':
        if (last && last.kind === 'thinking' && !last.done && sameAuthor(last)) last.text = (last.text ?? '') + text;
        else blocks.push({ kind: 'thinking', key: `b${this.blockSeq++}`, text, done: false, parentToolUseId: pid });
        break;
      case 'thinking':
        if (!finalizeOpen('thinking'))
          blocks.push({ kind: 'thinking', key: `b${this.blockSeq++}`, text, done: true, parentToolUseId: pid });
        break;
      case 'tool_use':
        blocks.push({
          kind: 'tool',
          key: `b${this.blockSeq++}`,
          toolId: typeof ev['id'] === 'string' ? (ev['id'] as string) : '',
          name: typeof ev['name'] === 'string' ? (ev['name'] as string) : 'tool',
          input: ev['input'],
          done: false,
          parentToolUseId: pid,
        });
        break;
      case 'tool_result': {
        const id = typeof ev['id'] === 'string' ? (ev['id'] as string) : '';
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (b.kind === 'tool' && !b.done && (b.toolId === id || id === '')) {
            b.result = ev['result'];
            b.isError = Boolean(ev['isError']);
            if (ev['structuredPatch'] !== undefined) b.structuredPatch = ev['structuredPatch'];
            b.done = true;
            break;
          }
        }
        break;
      }
      default:
        break; // session / result — not part of the visible turn
    }
  }
}
