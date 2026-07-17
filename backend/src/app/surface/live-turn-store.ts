import { Injectable } from '@nestjs/common';
import type { ContextBreakdown, JitInjection, JitInjectionRule } from '@shared/engine';
import { Observable, Subject } from 'rxjs';
import { isInterruptAbortResult } from '../brain/session-transcript';

export interface LiveTurnBlock {
  kind: 'text' | 'thinking' | 'tool' | 'user';
  key: string;
  text?: string;
  name?: string;
  toolId?: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
  superseded?: boolean;
  structuredPatch?: unknown;
  emittedAt: number;
  done: boolean;
  parentToolUseId?: string;
  bgSettled?: boolean;
  jitContext?: JitInjection[];
}

export interface LiveTurnSnapshot {
  jobId: string;
  lane: string;
  blocks: LiveTurnBlock[];
  active: boolean;
  seq: number;
  startedAt: number;
  retrying?: {
    attempt: number;
    max: number;
    retryDelayMs?: number;
    nextAttemptAt?: number;
    reason?: string;
  };
  contextBreakdown?: ContextBreakdown;
  contextTokens?: number;
  contextModel?: string;
  contextLimit?: number;
}

export interface LiveStreamFrame {
  channel: string;
  jobId: string;
  lane: string;
  seq: number;
  emittedAt?: number;
  event: unknown;
}

interface TurnState {
  jobId: string;
  lane: string;
  blocks: LiveTurnBlock[];
  active: boolean;
  lastSeq: number;
  startedAt: number;
  retrying?: {
    attempt: number;
    max: number;
    retryDelayMs?: number;
    nextAttemptAt?: number;
    reason?: string;
  };
  contextBreakdown?: ContextBreakdown;
  contextTokens?: number;
  contextModel?: string;
  contextLimit?: number;
}

export const MAIN_LANE = 'main';

@Injectable()
export class LiveTurnStore {
  private readonly subject = new Subject<LiveStreamFrame>();
  private readonly turns = new Map<string, Map<string, TurnState>>();
  private seq = 0;
  private blockSeq = 0;
  private lastBlockEmitMs = 0;

  private stamp(): number {
    this.lastBlockEmitMs = Math.max(Date.now(), this.lastBlockEmitMs + 1);
    return this.lastBlockEmitMs;
  }

  get stream$(): Observable<LiveStreamFrame> {
    return this.subject.asObservable();
  }

  push(
    channel: string,
    jobId: string,
    event: { kind: string; [k: string]: unknown },
    lane: string = MAIN_LANE,
  ): void {
    const isNew = !this.turns.get(channel)?.get(this.key(jobId, lane));
    const state = this.ensure(channel, jobId, lane);
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
    if (event.kind === 'api_retry') {
      state.retrying = {
        attempt: Number(event['attempt']),
        max: Number(event['maxRetries']),
        retryDelayMs: Number(event['retryDelayMs']),
        reason: typeof event['reason'] === 'string' ? (event['reason'] as string) : undefined,
      };
      const seq = ++this.seq;
      state.lastSeq = seq;
      this.subject.next({
        channel,
        jobId,
        lane,
        seq,
        event: {
          kind: 'turn_retry',
          attempt: state.retrying.attempt,
          max: state.retrying.max,
          retryDelayMs: state.retrying.retryDelayMs,
          reason: state.retrying.reason,
        },
      });
      return;
    }
    state.retrying = undefined;
    const emittedAt = this.applyToState(state, event);
    const seq = ++this.seq;
    state.lastSeq = seq;
    this.subject.next({
      channel,
      jobId,
      lane,
      seq,
      ...(emittedAt != null ? { emittedAt } : {}),
      event: emittedAt != null ? { ...event, emittedAt } : event,
    });
  }

  end(channel: string, jobId: string, lane: string = MAIN_LANE): void {
    const seq = ++this.seq;
    this.subject.next({
      channel,
      jobId,
      lane,
      seq,
      event: { kind: 'turn_end' },
    });
    this.turns.get(channel)?.delete(this.key(jobId, lane));
  }

  retry(
    channel: string,
    jobId: string,
    lane: string = MAIN_LANE,
    info: {
      attempt: number;
      max: number;
      retryDelayMs?: number;
      nextAttemptAt?: number;
      reason?: string;
    },
  ): void {
    const state = this.ensure(channel, jobId, lane);
    state.active = true;
    state.retrying = { ...info };
    const seq = ++this.seq;
    state.lastSeq = seq;
    this.subject.next({
      channel,
      jobId,
      lane,
      seq,
      event: {
        kind: 'turn_retry',
        attempt: info.attempt,
        max: info.max,
        ...(info.retryDelayMs != null ? { retryDelayMs: info.retryDelayMs } : {}),
        ...(info.nextAttemptAt != null ? { nextAttemptAt: info.nextAttemptAt } : {}),
        ...(info.reason != null ? { reason: info.reason } : {}),
      },
    });
  }

  reset(channel: string, jobId: string, lane: string = MAIN_LANE): void {
    this.turns.get(channel)?.delete(this.key(jobId, lane));
  }

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
      retrying: state.retrying,
      contextBreakdown: state.contextBreakdown,
      contextTokens: state.contextTokens,
      contextModel: state.contextModel,
      contextLimit: state.contextLimit,
    };
  }

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
      retrying: s.retrying,
      contextBreakdown: s.contextBreakdown,
      contextTokens: s.contextTokens,
      contextModel: s.contextModel,
      contextLimit: s.contextLimit,
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
      s = {
        jobId,
        lane,
        blocks: [],
        active: true,
        lastSeq: 0,
        startedAt: Date.now(),
      };
      m.set(k, s);
    }
    s.active = true;
    return s;
  }

  private applyToState(
    state: TurnState,
    ev: { kind: string; [k: string]: unknown },
  ): number | undefined {
    const blocks = state.blocks;
    const last = blocks[blocks.length - 1];
    const text = typeof ev['text'] === 'string' ? (ev['text'] as string) : '';
    const pid =
      typeof ev['parentToolUseId'] === 'string' ? (ev['parentToolUseId'] as string) : undefined;
    const sameAuthor = (b: LiveTurnBlock | undefined): boolean => !!b && b.parentToolUseId === pid;
    const finalizeOpen = (kind: 'text' | 'thinking'): number | undefined => {
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b.kind === kind && !b.done && b.parentToolUseId === pid) {
          b.text = text;
          b.done = true;
          return b.emittedAt;
        }
      }
      return undefined;
    };
    switch (ev.kind) {
      case 'text_delta':
        if (last && last.kind === 'text' && !last.done && sameAuthor(last)) {
          last.text = (last.text ?? '') + text;
          return last.emittedAt;
        } else {
          const emittedAt = this.stamp();
          blocks.push({
            kind: 'text',
            key: `b${this.blockSeq++}`,
            text,
            done: false,
            emittedAt,
            parentToolUseId: pid,
          });
          return emittedAt;
        }
        break;
      case 'text': {
        const existingEmittedAt = finalizeOpen('text');
        if (existingEmittedAt != null) return existingEmittedAt;
        const emittedAt = this.stamp();
        blocks.push({
          kind: 'text',
          key: `b${this.blockSeq++}`,
          text,
          done: true,
          emittedAt,
          parentToolUseId: pid,
        });
        return emittedAt;
      }
      case 'user_text': {
        if (!pid || !text.trim()) break;
        const emittedAt = this.stamp();
        blocks.push({
          kind: 'user',
          key: `b${this.blockSeq++}`,
          text,
          done: true,
          emittedAt,
          parentToolUseId: pid,
        });
        return emittedAt;
      }
      case 'thinking_delta':
        if (last && last.kind === 'thinking' && !last.done && sameAuthor(last)) {
          last.text = (last.text ?? '') + text;
          return last.emittedAt;
        } else {
          const emittedAt = this.stamp();
          blocks.push({
            kind: 'thinking',
            key: `b${this.blockSeq++}`,
            text,
            done: false,
            emittedAt,
            parentToolUseId: pid,
          });
          return emittedAt;
        }
        break;
      case 'thinking': {
        const existingEmittedAt = finalizeOpen('thinking');
        if (existingEmittedAt != null) return existingEmittedAt;
        const emittedAt = this.stamp();
        blocks.push({
          kind: 'thinking',
          key: `b${this.blockSeq++}`,
          text,
          done: true,
          emittedAt,
          parentToolUseId: pid,
        });
        return emittedAt;
      }
      case 'tool_use': {
        const emittedAt = this.stamp();
        blocks.push({
          kind: 'tool',
          key: `b${this.blockSeq++}`,
          toolId: typeof ev['id'] === 'string' ? (ev['id'] as string) : '',
          name: typeof ev['name'] === 'string' ? (ev['name'] as string) : 'tool',
          input: ev['input'],
          done: false,
          emittedAt,
          parentToolUseId: pid,
        });
        return emittedAt;
      }
      case 'tool_result': {
        const id = typeof ev['id'] === 'string' ? (ev['id'] as string) : '';
        const isError = Boolean(ev['isError']);
        const superseded = isError && isInterruptAbortResult(ev['result']);
        if (superseded) ev['superseded'] = true;
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (b.kind === 'tool' && !b.done && (b.toolId === id || id === '')) {
            b.result = ev['result'];
            b.isError = isError;
            if (superseded) b.superseded = true;
            if (ev['structuredPatch'] !== undefined) b.structuredPatch = ev['structuredPatch'];
            b.done = true;
            return b.emittedAt;
          }
        }
        break;
      }
      case 'jit_injection': {
        const id = typeof ev['id'] === 'string' ? (ev['id'] as string) : '';
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (b.kind === 'tool' && b.toolId === id) {
            const prior = b.jitContext ?? [];
            b.jitContext = [
              ...prior,
              {
                rule: ev['rule'] as JitInjectionRule,
                text: String(ev['text'] ?? ''),
              },
            ];
            return b.emittedAt;
          }
        }
        break;
      }
      case 'bg_task': {
        const status = ev['status'];
        if (pid && (status === 'completed' || status === 'failed' || status === 'stopped')) {
          for (let i = blocks.length - 1; i >= 0; i--) {
            const b = blocks[i];
            if (b.kind === 'tool' && b.toolId === pid) {
              b.bgSettled = true;
              return b.emittedAt;
            }
          }
        }
        break;
      }
      case 'usage': {
        if (!pid) {
          state.contextTokens =
            typeof ev['contextTokens'] === 'number'
              ? (ev['contextTokens'] as number)
              : state.contextTokens;
          if (typeof ev['contextModel'] === 'string')
            state.contextModel = ev['contextModel'] as string;
          if (typeof ev['contextLimit'] === 'number')
            state.contextLimit = ev['contextLimit'] as number;
        }
        return undefined; // live-only scalar, fanned verbatim below; no durable block
      }
      case 'context_breakdown': {
        if (!pid) state.contextBreakdown = ev['breakdown'] as ContextBreakdown;
        return undefined; // live-only, fanned verbatim below; no durable block
      }
      default:
        break; // session / result — not part of the visible turn
    }
    return undefined;
  }
}
