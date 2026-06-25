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
  done: boolean;
}

/** The cumulative state of a thread's in-flight turn — the RESUMABLE snapshot replayed on (re)connect. */
export interface LiveTurnSnapshot {
  threadId: string;
  blocks: LiveTurnBlock[];
  active: boolean;
  /** The highest frame `seq` reflected in this snapshot (the client dedupes deltas against it). */
  seq: number;
}

/** A frame fanned to SSE: an engine delta, a `{kind:'snapshot'}`, or a `{kind:'turn_end'}` — all seq'd. */
export interface LiveStreamFrame {
  channel: string;
  threadId: string;
  seq: number;
  event: unknown;
}

interface TurnState {
  blocks: LiveTurnBlock[];
  active: boolean;
  lastSeq: number;
}

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
 *   - A server restart mid-turn loses the in-flight turn — but the engine generation is killed too and
 *     can't be resumed, so showing a frozen partial would be worse; the client falls back to the durable
 *     transcript. (Cross-restart resume is intentionally out of scope.)
 *
 * `seq` is a process-global monotonic counter stamped on every frame; the client keeps the max it has
 * applied and ignores any delta with `seq <= snapshot.seq` — so the snapshot-then-live merge has no race.
 */
@Injectable()
export class LiveTurnStore {
  private readonly subject = new Subject<LiveStreamFrame>();
  /** channel (repoId) → threadId → cumulative in-flight turn. */
  private readonly turns = new Map<string, Map<string, TurnState>>();
  private seq = 0;
  private blockSeq = 0;

  /** The live frame feed — the SSE controller fans this to web clients (filtered by repo). */
  get stream$(): Observable<LiveStreamFrame> {
    return this.subject.asObservable();
  }

  /** Apply one engine event to a thread's in-flight turn (cumulative) AND fan it live with a fresh seq. */
  push(channel: string, threadId: string, event: { kind: string; [k: string]: unknown }): void {
    const state = this.ensure(channel, threadId);
    this.applyToState(state, event);
    const seq = ++this.seq;
    state.lastSeq = seq;
    this.subject.next({ channel, threadId, seq, event });
  }

  /** End a turn: fan a `turn_end` marker (so the client reconciles against the durable log), then drop it. */
  end(channel: string, threadId: string): void {
    const seq = ++this.seq;
    this.subject.next({ channel, threadId, seq, event: { kind: 'turn_end' } });
    this.turns.get(channel)?.delete(threadId);
  }

  /** The current cumulative snapshot for one thread (or null when no turn is in flight). */
  snapshot(channel: string, threadId: string): LiveTurnSnapshot | null {
    const state = this.turns.get(channel)?.get(threadId);
    if (!state) return null;
    return { threadId, blocks: state.blocks, active: state.active, seq: state.lastSeq };
  }

  /** Every in-flight turn for a repo — replayed to a client the moment its SSE connects. */
  snapshotsForRepo(channel: string): LiveTurnSnapshot[] {
    const m = this.turns.get(channel);
    if (!m) return [];
    return [...m.entries()].map(([threadId, s]) => ({
      threadId,
      blocks: s.blocks,
      active: s.active,
      seq: s.lastSeq,
    }));
  }

  private ensure(channel: string, threadId: string): TurnState {
    let m = this.turns.get(channel);
    if (!m) {
      m = new Map();
      this.turns.set(channel, m);
    }
    let s = m.get(threadId);
    if (!s) {
      s = { blocks: [], active: true, lastSeq: 0 };
      m.set(threadId, s);
    }
    s.active = true;
    return s;
  }

  /** Assemble cumulative blocks from engine events — identical logic to the web `thread-stream` store. */
  private applyToState(state: TurnState, ev: { kind: string; [k: string]: unknown }): void {
    const blocks = state.blocks;
    const last = blocks[blocks.length - 1];
    const text = typeof ev['text'] === 'string' ? (ev['text'] as string) : '';
    switch (ev.kind) {
      case 'text_delta':
        if (last && last.kind === 'text' && !last.done) last.text = (last.text ?? '') + text;
        else blocks.push({ kind: 'text', key: `b${this.blockSeq++}`, text, done: false });
        break;
      case 'text':
        if (last && last.kind === 'text' && !last.done) {
          last.text = text;
          last.done = true;
        } else blocks.push({ kind: 'text', key: `b${this.blockSeq++}`, text, done: true });
        break;
      case 'thinking_delta':
        if (last && last.kind === 'thinking' && !last.done) last.text = (last.text ?? '') + text;
        else blocks.push({ kind: 'thinking', key: `b${this.blockSeq++}`, text, done: false });
        break;
      case 'thinking':
        if (last && last.kind === 'thinking' && !last.done) {
          last.text = text;
          last.done = true;
        } else blocks.push({ kind: 'thinking', key: `b${this.blockSeq++}`, text, done: true });
        break;
      case 'tool_use':
        blocks.push({
          kind: 'tool',
          key: `b${this.blockSeq++}`,
          toolId: typeof ev['id'] === 'string' ? (ev['id'] as string) : '',
          name: typeof ev['name'] === 'string' ? (ev['name'] as string) : 'tool',
          input: ev['input'],
          done: false,
        });
        break;
      case 'tool_result': {
        const id = typeof ev['id'] === 'string' ? (ev['id'] as string) : '';
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (b.kind === 'tool' && !b.done && (b.toolId === id || id === '')) {
            b.result = ev['result'];
            b.isError = Boolean(ev['isError']);
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
