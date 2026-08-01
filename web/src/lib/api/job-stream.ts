'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

export interface ContextBreakdownCategory {
  name: string;
  tokens: number;
  color: string;
}
export interface ContextBreakdown {
  model: string;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  categories: ContextBreakdownCategory[];
  mcpTools?: { name: string; serverName: string; tokens: number }[];
  memoryFiles?: { path: string; tokens: number }[];
  agents?: { agentType: string; tokens: number }[];
}

export type LiveBlock =
  | {
      kind: 'text';
      key: string;
      text: string;
      done: boolean;
      parentToolUseId?: string;
      emittedAt: number;
    }
  | {
      kind: 'user';
      key: string;
      text: string;
      done: boolean;
      parentToolUseId?: string;
      emittedAt: number;
    }
  | {
      kind: 'thinking';
      key: string;
      text: string;
      done: boolean;
      parentToolUseId?: string;
      emittedAt: number;
    }
  | {
      kind: 'tool';
      key: string;
      toolId?: string;
      name: string;
      input?: unknown;
      result?: unknown;
      isError?: boolean;
      superseded?: boolean;
      structuredPatch?: unknown;
      jitContext?: Array<{ rule: string; text: string }>;
      done: boolean;
      bgSettled?: boolean;
      bgStarted?: boolean;
      parentToolUseId?: string;
      emittedAt: number;
    };

export interface LiveTurn {
  blocks: LiveBlock[];
  active: boolean;
  lastSeq: number;
  startedAt?: number;
  contextTokens?: number;
  contextModel?: string;
  contextLimit?: number;
  contextBreakdown?: ContextBreakdown;
  subUsage?: Record<string, { contextTokens: number; contextModel?: string; contextLimit: number }>;
  retrying?: {
    attempt: number;
    max: number;
    nextAttemptAt?: number;
    reason?: string;
  };
}

type StreamPayload = {
  kind?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
  superseded?: boolean;
  structuredPatch?: unknown;
  rule?: string;
  parentToolUseId?: string;
  status?: string;
  blockKind?: 'text' | 'thinking';
  blocks?: LiveBlock[];
  active?: boolean;
  startedAt?: number;
  contextTokens?: number;
  contextModel?: string;
  contextLimit?: number;
  breakdown?: ContextBreakdown;
  contextBreakdown?: ContextBreakdown;
  emittedAt?: number;
  attempt?: number;
  max?: number;
  retryDelayMs?: number;
  nextAttemptAt?: number;
  reason?: string;
  retrying?: LiveTurn['retrying'];
};

let blockSeq = 0;

export const MAIN_LANE = 'main';
const laneKey = (jobId: string, lane: string): string => `${jobId}::${lane}`;

const RECONNECT_SWEEP_GRACE_MS = 3_000;

class ThreadStreamStore {
  private map = new Map<string, LiveTurn>();
  private epoch = 0;
  private readonly touchedEpoch = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly keyListeners = new Map<string, Set<() => void>>();

  apply(jobId: string, lane: string, seq: number, ev: StreamPayload | null | undefined): void {
    if (!jobId || !ev?.kind) return;
    const key = laneKey(jobId, lane);
    this.touchedEpoch.set(key, this.epoch);
    const cur = this.map.get(key);

    if (ev.kind === 'turn_start') {
      if (cur && seq <= cur.lastSeq) return;
      this.map.set(key, {
        blocks: [],
        active: true,
        lastSeq: seq,
        startedAt: ev.startedAt ?? cur?.startedAt ?? Date.now(),
      });
      this.notify(key);
      return;
    }

    if (ev.kind === 'snapshot') {
      if (cur && seq < cur.lastSeq) return;
      this.map.set(key, {
        blocks: (ev.blocks ?? []).map((b) => ({ ...b })),
        active: ev.active ?? true,
        lastSeq: seq,
        startedAt: ev.startedAt ?? cur?.startedAt,
        contextTokens: ev.contextTokens ?? cur?.contextTokens,
        contextModel: ev.contextModel ?? cur?.contextModel,
        contextLimit: ev.contextLimit ?? cur?.contextLimit,
        contextBreakdown: ev.contextBreakdown ?? cur?.contextBreakdown,
        retrying: ev.retrying,
      });
      this.notify(key);
      return;
    }

    if (ev.kind === 'turn_retry') {
      if (cur && seq <= cur.lastSeq) return;
      const nextAttemptAt =
        ev.nextAttemptAt ?? (ev.retryDelayMs != null ? Date.now() + ev.retryDelayMs : undefined);
      this.map.set(key, {
        blocks: cur?.blocks ?? [],
        active: true,
        lastSeq: seq,
        startedAt: cur?.startedAt,
        contextTokens: cur?.contextTokens,
        contextModel: cur?.contextModel,
        contextLimit: cur?.contextLimit,
        subUsage: cur?.subUsage,
        contextBreakdown: cur?.contextBreakdown,
        retrying: {
          attempt: ev.attempt ?? 0,
          max: ev.max ?? 0,
          nextAttemptAt,
          reason: ev.reason,
        },
      });
      this.notify(key);
      return;
    }

    if (cur && seq <= cur.lastSeq) return;

    const blocks = cur ? [...cur.blocks] : [];
    const last = blocks[blocks.length - 1];
    const text = typeof ev.text === 'string' ? ev.text : '';
    const pid = ev.parentToolUseId;
    const sameAuthor = (b: LiveBlock | undefined): boolean => !!b && b.parentToolUseId === pid;
    const finalizeOpen = (kind: 'text' | 'thinking'): boolean => {
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b.kind === kind && !b.done && b.parentToolUseId === pid) {
          blocks[i] = { ...b, text, done: true };
          return true;
        }
      }
      return false;
    };

    switch (ev.kind) {
      case 'text_delta':
        if (last && last.kind === 'text' && !last.done && sameAuthor(last))
          blocks[blocks.length - 1] = { ...last, text: last.text + text };
        else
          blocks.push({
            kind: 'text',
            key: `c${blockSeq++}`,
            text,
            done: false,
            parentToolUseId: pid,
            emittedAt: ev.emittedAt ?? Date.now(),
          });
        break;
      case 'text':
        if (!finalizeOpen('text'))
          blocks.push({
            kind: 'text',
            key: `c${blockSeq++}`,
            text,
            done: true,
            parentToolUseId: pid,
            emittedAt: ev.emittedAt ?? Date.now(),
          });
        break;
      case 'user_text':
        if (!pid || !text.trim()) break;
        blocks.push({
          kind: 'user',
          key: `c${blockSeq++}`,
          text,
          done: true,
          parentToolUseId: pid,
          emittedAt: ev.emittedAt ?? Date.now(),
        });
        break;
      case 'thinking_delta':
        if (last && last.kind === 'thinking' && !last.done && sameAuthor(last))
          blocks[blocks.length - 1] = { ...last, text: last.text + text };
        else
          blocks.push({
            kind: 'thinking',
            key: `c${blockSeq++}`,
            text,
            done: false,
            parentToolUseId: pid,
            emittedAt: ev.emittedAt ?? Date.now(),
          });
        break;
      case 'thinking':
        if (!finalizeOpen('thinking'))
          blocks.push({
            kind: 'thinking',
            key: `c${blockSeq++}`,
            text,
            done: true,
            parentToolUseId: pid,
            emittedAt: ev.emittedAt ?? Date.now(),
          });
        break;
      case 'block_done': {
        const kind = ev.blockKind === 'thinking' ? 'thinking' : 'text';
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (b.kind === kind && !b.done && b.parentToolUseId === pid) {
            blocks[i] = { ...b, done: true };
            break;
          }
        }
        break;
      }
      case 'tool_use':
        blocks.push({
          kind: 'tool',
          key: `c${blockSeq++}`,
          toolId: typeof ev.id === 'string' ? ev.id : '',
          name: typeof ev.name === 'string' ? ev.name : 'tool',
          input: ev.input,
          done: false,
          parentToolUseId: pid,
          emittedAt: ev.emittedAt ?? Date.now(),
        });
        break;
      case 'tool_result': {
        const id = typeof ev.id === 'string' ? ev.id : '';
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (b.kind === 'tool' && !b.done && (b.toolId === id || id === '')) {
            blocks[i] = {
              ...b,
              result: ev.result,
              isError: Boolean(ev.isError),
              superseded: Boolean(ev.superseded),
              ...(ev.structuredPatch !== undefined ? { structuredPatch: ev.structuredPatch } : {}),
              done: true,
            };
            break;
          }
        }
        break;
      }
      case 'jit_injection': {
        const id = typeof ev.id === 'string' ? ev.id : '';
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (b.kind === 'tool' && b.toolId === id) {
            const prior = b.jitContext ?? [];
            blocks[i] = {
              ...b,
              jitContext: [
                ...prior,
                {
                  rule: String(ev.rule ?? ''),
                  text: typeof ev.text === 'string' ? ev.text : '',
                },
              ],
            };
            break;
          }
        }
        break;
      }
      case 'bg_task': {
        const st = ev.status;
        const settled = st === 'completed' || st === 'failed' || st === 'stopped';
        if (pid && (st === 'started' || settled)) {
          for (let i = blocks.length - 1; i >= 0; i--) {
            const b = blocks[i];
            if (b.kind === 'tool' && b.toolId === pid) {
              blocks[i] = {
                ...b,
                ...(st === 'started' ? { bgStarted: true } : {}),
                ...(settled ? { bgSettled: true } : {}),
              };
              break;
            }
          }
        }
        break;
      }
      case 'usage': {
        const subPid = ev.parentToolUseId;
        if (typeof subPid === 'string') {
          this.map.set(key, {
            blocks,
            active: true,
            lastSeq: seq,
            startedAt: cur?.startedAt,
            contextTokens: cur?.contextTokens,
            contextModel: cur?.contextModel,
            contextLimit: cur?.contextLimit,
            subUsage: {
              ...cur?.subUsage,
              [subPid]: {
                contextTokens:
                  typeof ev.contextTokens === 'number'
                    ? ev.contextTokens
                    : (cur?.subUsage?.[subPid]?.contextTokens ?? 0),
                contextModel:
                  typeof ev.contextModel === 'string'
                    ? ev.contextModel
                    : cur?.subUsage?.[subPid]?.contextModel,
                contextLimit:
                  typeof ev.contextLimit === 'number'
                    ? ev.contextLimit
                    : (cur?.subUsage?.[subPid]?.contextLimit ?? 0),
              },
            },
            contextBreakdown: cur?.contextBreakdown,
          });
          this.notify(key);
          return;
        }
        this.map.set(key, {
          blocks,
          active: true,
          lastSeq: seq,
          startedAt: cur?.startedAt,
          contextTokens:
            typeof ev.contextTokens === 'number' ? ev.contextTokens : cur?.contextTokens,
          contextModel: typeof ev.contextModel === 'string' ? ev.contextModel : cur?.contextModel,
          contextLimit: typeof ev.contextLimit === 'number' ? ev.contextLimit : cur?.contextLimit,
          subUsage: cur?.subUsage,
          contextBreakdown: cur?.contextBreakdown,
        });
        this.notify(key);
        return;
      }
      case 'context_breakdown': {
        if (ev.parentToolUseId) {
          this.map.set(key, {
            blocks,
            active: true,
            lastSeq: seq,
            startedAt: cur?.startedAt,
            contextTokens: cur?.contextTokens,
            contextModel: cur?.contextModel,
            contextLimit: cur?.contextLimit,
            subUsage: cur?.subUsage,
            contextBreakdown: cur?.contextBreakdown,
          });
          this.notify(key);
          return;
        }
        this.map.set(key, {
          blocks,
          active: true,
          lastSeq: seq,
          startedAt: cur?.startedAt,
          contextTokens: cur?.contextTokens,
          contextModel: cur?.contextModel,
          contextLimit: cur?.contextLimit,
          subUsage: cur?.subUsage,
          contextBreakdown: ev.breakdown ?? cur?.contextBreakdown,
        });
        this.notify(key);
        return;
      }
      default:
        // session / result — advance seq but don't change rendered blocks.
        this.map.set(key, {
          blocks,
          active: true,
          lastSeq: seq,
          startedAt: cur?.startedAt,
          contextTokens: cur?.contextTokens,
          contextModel: cur?.contextModel,
          contextLimit: cur?.contextLimit,
          subUsage: cur?.subUsage,
          contextBreakdown: cur?.contextBreakdown,
        });
        this.notify(key);
        return;
    }

    this.map.set(key, {
      blocks,
      active: true,
      lastSeq: seq,
      startedAt: cur?.startedAt,
      // Carry the live occupancy across block deltas so a text/tool frame doesn't wipe the ring mid-turn.
      contextTokens: cur?.contextTokens,
      contextModel: cur?.contextModel,
      contextLimit: cur?.contextLimit,
      subUsage: cur?.subUsage,
      contextBreakdown: cur?.contextBreakdown,
    });
    this.notify(key);
  }

  end(jobId: string, lane: string, endSeq?: number): void {
    const key = laneKey(jobId, lane);
    const cur = this.map.get(key);
    // A stale turn_end must not clobber a turn that a newer frame (a turn_retry) just re-activated.
    if (cur && endSeq != null && cur.lastSeq > endSeq) return;
    this.touchedEpoch.delete(key);
    if (!cur) return;
    this.map.delete(key);
    this.notify(key);
  }

  sweepAfterReconnect(): void {
    this.epoch += 1;
    const sweepEpoch = this.epoch;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      for (const key of [...this.map.keys()]) {
        if ((this.touchedEpoch.get(key) ?? 0) < sweepEpoch) {
          this.touchedEpoch.delete(key);
          this.map.delete(key);
          this.notify(key);
        }
      }
    }, RECONNECT_SWEEP_GRACE_MS);
  }

  getByKey(key: string): LiveTurn | undefined {
    return this.map.get(key);
  }

  get(jobId: string, lane: string): LiveTurn | undefined {
    return this.map.get(laneKey(jobId, lane));
  }

  private notify(key: string): void {
    this.keyListeners.get(key)?.forEach((l) => l());
  }

  subscribeKey(key: string, cb: () => void): () => void {
    let set = this.keyListeners.get(key);
    if (!set) {
      set = new Set();
      this.keyListeners.set(key, set);
    }
    set.add(cb);
    return () => {
      const s = this.keyListeners.get(key);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.keyListeners.delete(key);
    };
  }
}

const store = new ThreadStreamStore();

export function applyStreamFrame(jobId: string, lane: string, seq: number, event: unknown): void {
  store.apply(jobId, lane, seq, event as StreamPayload);
}

export function endLiveTurn(jobId: string, lane: string = MAIN_LANE, endSeq?: number): void {
  store.end(jobId, lane, endSeq);
}

export function peekLiveTurn(jobId: string, lane: string = MAIN_LANE): LiveTurn | undefined {
  return store.get(jobId, lane);
}

export function sweepLiveTurnsAfterReconnect(): void {
  store.sweepAfterReconnect();
}

export function useLiveTurn(jobId: string, lane: string = MAIN_LANE): LiveTurn | undefined {
  const key = laneKey(jobId, lane);
  const subscribe = useCallback((cb: () => void) => store.subscribeKey(key, cb), [key]);
  const getByKey = useCallback(() => store.getByKey(key), [key]);
  return useSyncExternalStore(subscribe, getByKey, () => undefined);
}

export type LiveStatusWord = 'still thinking' | 'using tools' | 'responding';

export function summarizeLiveTurn(turn: LiveTurn | undefined): {
  openTools: number;
  statusWord: LiveStatusWord;
} {
  const blocks = turn?.blocks ?? [];
  let openTools = 0;
  for (const b of blocks) if (b.kind === 'tool' && !b.done) openTools += 1;
  const last = blocks[blocks.length - 1];
  const statusWord: LiveStatusWord =
    last?.kind === 'thinking'
      ? 'still thinking'
      : last?.kind === 'tool'
        ? 'using tools'
        : 'responding';
  return { openTools, statusWord };
}

export function useElapsedSeconds(startedAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (startedAt == null) return 0;
  return Math.max(0, Math.round((now - startedAt) / 1_000));
}

export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  const seconds = s % 60;
  if (hours > 0)
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export function retryCountdownSeconds(targetMs: number | undefined, now: number): number | null {
  if (targetMs == null) return null;
  const remainingMs = targetMs - now;
  if (remainingMs <= 0) return null;
  return Math.ceil(remainingMs / 1_000);
}

if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  (window as unknown as Record<string, unknown>).__atlasLiveStream = {
    applyStreamFrame,
    endLiveTurn,
    peekLiveTurn,
  };
}
