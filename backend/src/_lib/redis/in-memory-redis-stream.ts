import type { RedisStreamPort, StreamEntry } from './redis.port';

/**
 * A deterministic, dependency-free in-memory `RedisStreamPort` for UNIT TESTS — the full host↔daemon
 * round-trips run against this with NO live Redis.
 *
 * It models the slice of Redis-stream + pub/sub semantics Phase 5 relies on:
 *  - streams are append-only ordered logs with monotonic `<seq>-0` ids;
 *  - `xadd` wakes any blocked `xread`/`xreadGroup` waiting on that stream (so a daemon consumer loop
 *    and a host event-tail interleave correctly within one process/event-loop);
 *  - consumer groups thread a per-group cursor (last delivered id) so `'>'` reads only NEW entries, a
 *    pending-entries list (PEL) holds delivered-but-un-acked entries, `ack` removes them, and
 *    `claimStale` reassigns idle ones (XAUTOCLAIM) — the crash-recovery slice the tool-bridge needs;
 *  - `xread` resumes strictly AFTER `lastId`, exactly like real Redis, so the host's resume-after-
 *    transient-read logic is exercised faithfully;
 *  - pub/sub `publish`/`subscribe` deliver synchronously to current subscribers.
 *
 * Blocking reads honor `blockMs`: they resolve early when a matching entry arrives, else resolve []
 * at the timeout. Tests drive real time via the event loop (small block windows), so they stay fast.
 */
export class InMemoryRedisStream implements RedisStreamPort {
  private readonly streams = new Map<string, StreamEntry[]>();
  /** stream → group → last-delivered entry id (the group cursor). */
  private readonly groups = new Map<string, Map<string, string>>();
  /**
   * Pending-entries list (PEL): stream → group → id → {consumer, deliveredAt}. An entry enters on
   * `xreadGroup` delivery and leaves on `ack`; `claimStale` reassigns idle ones. Models exactly the
   * crash-recovery slice of XAUTOCLAIM the tool-bridge relies on.
   */
  private readonly pending = new Map<
    string,
    Map<string, Map<string, { consumer: string; deliveredAt: number }>>
  >();
  /** Wake callbacks registered by blocked readers, keyed by stream. */
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly subscribers = new Map<
    string,
    Set<(message: unknown) => void>
  >();
  /** Pending block timers — released eagerly by `releaseBlockingReads()` (test teardown speed-up). */
  private readonly blockTimers = new Set<{ resolve: () => void }>();
  private seq = 0;

  /**
   * TEST HELPER: immediately resolve every currently-blocked `xread`/`xreadGroup` as a timeout (empty
   * result), instead of waiting out its `blockMs`. Production code never calls this; tests call it in
   * teardown so a consumer loop parked in a long blocking read exits at once (no multi-second waits).
   */
  releaseBlockingReads(): void {
    for (const t of [...this.blockTimers]) t.resolve();
  }

  // ── streams ────────────────────────────────────────────────────────────────────────────────

  xadd(stream: string, data: unknown): Promise<string> {
    const id = `${++this.seq}-0`;
    const log = this.streams.get(stream) ?? [];
    log.push({ id, data: clone(data) });
    this.streams.set(stream, log);
    this.wake(stream);
    return Promise.resolve(id);
  }

  del(...keys: string[]): Promise<void> {
    for (const k of keys) {
      this.streams.delete(k);
      this.groups.delete(k);
      this.pending.delete(k);
    }
    return Promise.resolve();
  }

  ensureGroup(stream: string, group: string): Promise<void> {
    const byGroup = this.groups.get(stream) ?? new Map<string, string>();
    if (!byGroup.has(group)) byGroup.set(group, '0-0'); // deliver from the start
    this.groups.set(stream, byGroup);
    if (!this.streams.has(stream)) this.streams.set(stream, []); // MKSTREAM
    return Promise.resolve();
  }

  async xreadGroup(args: {
    group: string;
    consumer: string;
    stream: string;
    count: number;
    blockMs: number;
  }): Promise<StreamEntry[]> {
    const take = (): StreamEntry[] => {
      const cursor = this.groups.get(args.stream)?.get(args.group) ?? '0-0';
      const log = this.streams.get(args.stream) ?? [];
      const fresh = log
        .filter((e) => cmpId(e.id, cursor) > 0)
        .slice(0, args.count);
      if (fresh.length) {
        // Advance the group cursor past the last delivered entry.
        this.groups
          .get(args.stream)
          ?.set(args.group, fresh[fresh.length - 1].id);
        // Record each delivered entry in the PEL (un-acked, owned by this consumer) for crash recovery.
        const pel = this.pelFor(args.stream, args.group);
        for (const e of fresh) {
          pel.set(e.id, { consumer: args.consumer, deliveredAt: Date.now() });
        }
      }
      return fresh.map((e) => ({ id: e.id, data: clone(e.data) }));
    };
    return this.blockingRead(args.stream, args.blockMs, take);
  }

  ack(stream: string, group: string, ids: string[]): Promise<void> {
    const pel = this.pending.get(stream)?.get(group);
    if (pel) for (const id of ids) pel.delete(id);
    return Promise.resolve();
  }

  claimStale(args: {
    group: string;
    consumer: string;
    stream: string;
    minIdleMs: number;
    count: number;
  }): Promise<StreamEntry[]> {
    const pel = this.pelFor(args.stream, args.group);
    const log = this.streams.get(args.stream) ?? [];
    const now = Date.now();
    const out: StreamEntry[] = [];
    // Oldest-first (insertion order) so recovery drains the longest-stranded entries first.
    for (const [id, meta] of pel) {
      if (out.length >= args.count) break;
      if (now - meta.deliveredAt < args.minIdleMs) continue;
      const entry = log.find((e) => e.id === id);
      if (!entry) {
        pel.delete(id); // entry trimmed away — drop the dangling PEL record
        continue;
      }
      // Reassign ownership + reset idle (mirrors XAUTOCLAIM), then hand it back for reprocessing.
      meta.consumer = args.consumer;
      meta.deliveredAt = now;
      out.push({ id, data: clone(entry.data) });
    }
    return Promise.resolve(out);
  }

  /** Get (creating if absent) the PEL map for a stream+group. */
  private pelFor(
    stream: string,
    group: string,
  ): Map<string, { consumer: string; deliveredAt: number }> {
    const byGroup =
      this.pending.get(stream) ??
      new Map<string, Map<string, { consumer: string; deliveredAt: number }>>();
    this.pending.set(stream, byGroup);
    const pel = byGroup.get(group) ?? new Map();
    byGroup.set(group, pel);
    return pel;
  }

  async xread(args: {
    stream: string;
    lastId: string;
    count: number;
    blockMs: number;
  }): Promise<StreamEntry[]> {
    const take = (): StreamEntry[] => {
      const log = this.streams.get(args.stream) ?? [];
      return log
        .filter((e) => cmpId(e.id, args.lastId) > 0)
        .slice(0, args.count)
        .map((e) => ({ id: e.id, data: clone(e.data) }));
    };
    return this.blockingRead(args.stream, args.blockMs, take);
  }

  /** Resolve `take()` immediately if it yields, else wait for an `xadd` on this stream (or timeout). */
  private blockingRead(
    stream: string,
    blockMs: number,
    take: () => StreamEntry[],
  ): Promise<StreamEntry[]> {
    const immediate = take();
    if (immediate.length) return Promise.resolve(immediate);
    return new Promise<StreamEntry[]>((resolve) => {
      let settled = false;
      const set = this.waiters.get(stream) ?? new Set<() => void>();
      const finishEmpty = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        set.delete(onWake);
        this.blockTimers.delete(handle);
        resolve([]);
      };
      const onWake = (): void => {
        if (settled) return;
        const next = take();
        if (next.length) {
          settled = true;
          clearTimeout(timer);
          set.delete(onWake);
          this.blockTimers.delete(handle);
          resolve(next);
        }
      };
      const timer = setTimeout(finishEmpty, blockMs);
      // Don't keep the test process alive on a pending block window.
      if (typeof timer.unref === 'function') timer.unref();
      // Thread for eager release (test teardown) — resolving as a timeout (empty).
      const handle = { resolve: finishEmpty };
      this.blockTimers.add(handle);
      set.add(onWake);
      this.waiters.set(stream, set);
    });
  }

  private wake(stream: string): void {
    const set = this.waiters.get(stream);
    if (!set) return;
    // Snapshot — onWake mutates the set as waiters resolve.
    for (const w of [...set]) w();
  }

  // ── pub/sub ────────────────────────────────────────────────────────────────────────────────

  publish(channel: string, message: unknown): Promise<number> {
    const subs = this.subscribers.get(channel);
    if (!subs) return Promise.resolve(0);
    for (const h of [...subs]) h(clone(message));
    return Promise.resolve(subs.size);
  }

  subscribe(
    channel: string,
    handler: (message: unknown) => void,
  ): Promise<() => Promise<void>> {
    const subs = this.subscribers.get(channel) ?? new Set();
    subs.add(handler);
    this.subscribers.set(channel, subs);
    return Promise.resolve(() => {
      subs.delete(handler);
      return Promise.resolve();
    });
  }
}

/** Structured-clone-ish deep copy so a stored frame can't be mutated by a caller after read/write
 * (mirrors the JSON round-trip a real Redis would impose). */
function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Compare two `<seq>-<sub>` stream ids numerically (the fake only ever uses `-0`). */
function cmpId(a: string, b: string): number {
  const [as, asub] = a.split('-').map(Number);
  const [bs, bsub] = b.split('-').map(Number);
  return as !== bs ? as - bs : asub - bsub;
}
