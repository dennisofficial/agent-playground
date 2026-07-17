import type { RedisStreamPort, StreamEntry } from './redis.port';

export class InMemoryRedisStream implements RedisStreamPort {
  private readonly streams = new Map<string, StreamEntry[]>();
  private readonly groups = new Map<string, Map<string, string>>();
  private readonly pending = new Map<
    string,
    Map<string, Map<string, { consumer: string; deliveredAt: number }>>
  >();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly subscribers = new Map<string, Set<(message: unknown) => void>>();
  private readonly blockTimers = new Set<{ resolve: () => void }>();
  private readonly lastAccess = new Map<string, number>();
  private seq = 0;

  releaseBlockingReads(): void {
    for (const t of [...this.blockTimers]) t.resolve();
  }

  setKeyIdleForTest(key: string, seconds: number): void {
    this.lastAccess.set(key, Date.now() - seconds * 1000);
  }


  xadd(stream: string, data: unknown): Promise<string> {
    const id = `${++this.seq}-0`;
    const log = this.streams.get(stream) ?? [];
    log.push({ id, data: clone(data) });
    this.streams.set(stream, log);
    this.lastAccess.set(stream, Date.now());
    this.wake(stream);
    return Promise.resolve(id);
  }

  del(...keys: string[]): Promise<void> {
    for (const k of keys) {
      this.streams.delete(k);
      this.groups.delete(k);
      this.pending.delete(k);
      this.lastAccess.delete(k);
    }
    return Promise.resolve();
  }

  scanKeys(match: string, _count?: number): Promise<string[]> {
    const re = globToRegExp(match);
    return Promise.resolve([...this.streams.keys()].filter((k) => re.test(k)));
  }

  objectIdleTime(key: string): Promise<number | null> {
    if (!this.streams.has(key)) return Promise.resolve(null);
    const last = this.lastAccess.get(key) ?? Date.now();
    return Promise.resolve(Math.floor((Date.now() - last) / 1000));
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
    this.lastAccess.set(args.stream, Date.now());
    const take = (): StreamEntry[] => {
      const cursor = this.groups.get(args.stream)?.get(args.group) ?? '0-0';
      const log = this.streams.get(args.stream) ?? [];
      const fresh = log.filter((e) => cmpId(e.id, cursor) > 0).slice(0, args.count);
      if (fresh.length) {
        this.groups.get(args.stream)?.set(args.group, fresh[fresh.length - 1].id);
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
    for (const [id, meta] of pel) {
      if (out.length >= args.count) break;
      if (now - meta.deliveredAt < args.minIdleMs) continue;
      const entry = log.find((e) => e.id === id);
      if (!entry) {
        pel.delete(id); // entry trimmed away — drop the dangling PEL record
        continue;
      }
      meta.consumer = args.consumer;
      meta.deliveredAt = now;
      out.push({ id, data: clone(entry.data) });
    }
    return Promise.resolve(out);
  }

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
    this.lastAccess.set(args.stream, Date.now());
    const take = (): StreamEntry[] => {
      const log = this.streams.get(args.stream) ?? [];
      return log
        .filter((e) => cmpId(e.id, args.lastId) > 0)
        .slice(0, args.count)
        .map((e) => ({ id: e.id, data: clone(e.data) }));
    };
    return this.blockingRead(args.stream, args.blockMs, take);
  }

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
      if (typeof timer.unref === 'function') timer.unref();
      const handle = { resolve: finishEmpty };
      this.blockTimers.add(handle);
      set.add(onWake);
      this.waiters.set(stream, set);
    });
  }

  private wake(stream: string): void {
    const set = this.waiters.get(stream);
    if (!set) return;
    for (const w of [...set]) w();
  }


  publish(channel: string, message: unknown): Promise<number> {
    const subs = this.subscribers.get(channel);
    if (!subs) return Promise.resolve(0);
    for (const h of [...subs]) h(clone(message));
    return Promise.resolve(subs.size);
  }

  subscribe(channel: string, handler: (message: unknown) => void): Promise<() => Promise<void>> {
    const subs = this.subscribers.get(channel) ?? new Set();
    subs.add(handler);
    this.subscribers.set(channel, subs);
    return Promise.resolve(() => {
      subs.delete(handler);
      return Promise.resolve();
    });
  }
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function cmpId(a: string, b: string): number {
  const [as, asub] = a.split('-').map(Number);
  const [bs, bsub] = b.split('-').map(Number);
  return as !== bs ? as - bs : asub - bsub;
}
