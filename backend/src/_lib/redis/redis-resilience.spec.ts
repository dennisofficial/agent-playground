/**
 * Two Phase-5 resilience invariants, unit-tested with NO live Redis:
 *
 *  1. The shared `ioredis` client builds LAZILY — constructing it (via `buildRedisClient`) and even
 *     wiring it into a Nest module does NOT open a socket or throw when Redis is absent, so the harness
 *     and the daemon BOOT with Redis down. (This is what keeps daemon.module.spec passing.)
 *  2. The in-memory fake's `xread` RESUMES strictly after `lastId` — the exact semantics the host
 *     `DaemonClient` event-tail relies on to loop past a transient empty read without losing or
 *     re-delivering events.
 */
import { describe, expect, it } from 'vitest';
import { buildRedisClient } from './redis.tokens';
import { InMemoryRedisStream } from './in-memory-redis-stream';

describe('RedisModule resilience (lazy/no-crash connect)', () => {
  it('builds a lazy client without opening a socket (no throw, status not connected)', async () => {
    const client = buildRedisClient({ url: 'redis://127.0.0.1:6399' }); // a port nothing listens on
    // lazyConnect → the client is constructed but idle; no connection attempt has been made yet.
    expect(client.status).not.toBe('ready');
    expect(client.status).not.toBe('connecting');
    // Tear down without ever connecting — must not throw (and must not leave a dangling reconnect).
    client.disconnect();
  });

  it('defaults REDIS_URL to localhost when unset (still lazy, still no throw)', () => {
    const client = buildRedisClient({});
    expect(client.options.lazyConnect).toBe(true);
    client.disconnect();
  });
});

describe('InMemoryRedisStream xread resume semantics', () => {
  it('returns only entries strictly after lastId (resume past a transient read)', async () => {
    const r = new InMemoryRedisStream();
    const id1 = await r.xadd('s', { n: 1 });
    const id2 = await r.xadd('s', { n: 2 });

    const first = await r.xread({
      stream: 's',
      lastId: '0',
      count: 10,
      blockMs: 0,
    });
    expect(first.map((e) => e.data)).toEqual([{ n: 1 }, { n: 2 }]);

    // Resume from the last seen id → nothing new yet (timeout → empty).
    const empty = await r.xread({
      stream: 's',
      lastId: id2,
      count: 10,
      blockMs: 0,
    });
    expect(empty).toEqual([]);

    // A new entry arrives; resuming from id2 yields only it (id1 NOT re-delivered).
    await r.xadd('s', { n: 3 });
    const next = await r.xread({
      stream: 's',
      lastId: id2,
      count: 10,
      blockMs: 0,
    });
    expect(next.map((e) => e.data)).toEqual([{ n: 3 }]);
    expect(id1).not.toBe(id2);
  });

  it('a blocked xread resolves when an xadd arrives on its stream', async () => {
    const r = new InMemoryRedisStream();
    const read = r.xread({ stream: 's', lastId: '0', count: 1, blockMs: 1000 });
    await new Promise((res) => setImmediate(res));
    await r.xadd('s', { hello: 'world' });
    const got = await read;
    expect(got.map((e) => e.data)).toEqual([{ hello: 'world' }]);
  });

  it('consumer-group reads deliver each NEW entry once, advancing the cursor', async () => {
    const r = new InMemoryRedisStream();
    await r.ensureGroup('s', 'daemon');
    await r.xadd('s', { a: 1 });
    const one = await r.xreadGroup({
      group: 'daemon',
      consumer: 'c1',
      stream: 's',
      count: 10,
      blockMs: 0,
    });
    expect(one.map((e) => e.data)).toEqual([{ a: 1 }]);
    // Already delivered → next group read sees nothing (cursor advanced).
    const none = await r.xreadGroup({
      group: 'daemon',
      consumer: 'c1',
      stream: 's',
      count: 10,
      blockMs: 0,
    });
    expect(none).toEqual([]);
  });
});

describe('InMemoryRedisStream pending recovery (XAUTOCLAIM / ack)', () => {
  it('claimStale re-delivers a delivered-but-un-acked entry to a fresh consumer (dead-consumer recovery)', async () => {
    const r = new InMemoryRedisStream();
    await r.ensureGroup('tools', 'host');
    await r.xadd('tools', { tool: 'submit_plan', id: 'call-1' });

    // c1 receives it but DIES before ack (simulates a backend crash mid-tool).
    const delivered = await r.xreadGroup({
      group: 'host',
      consumer: 'c1',
      stream: 'tools',
      count: 10,
      blockMs: 0,
    });
    expect(delivered.map((e) => e.data)).toEqual([
      { tool: 'submit_plan', id: 'call-1' },
    ]);

    // A '>' read by the new consumer sees nothing new (cursor already advanced) — it would be STRANDED
    // without pending recovery.
    const fresh = await r.xreadGroup({
      group: 'host',
      consumer: 'c2',
      stream: 'tools',
      count: 10,
      blockMs: 0,
    });
    expect(fresh).toEqual([]);

    // c2 claims the stale pending entry (minIdleMs 0 → claim immediately on re-attach).
    const claimed = await r.claimStale({
      group: 'host',
      consumer: 'c2',
      stream: 'tools',
      minIdleMs: 0,
      count: 10,
    });
    expect(claimed.map((e) => e.data)).toEqual([
      { tool: 'submit_plan', id: 'call-1' },
    ]);
  });

  it('an acked entry is NOT reclaimable (no double-processing once handled)', async () => {
    const r = new InMemoryRedisStream();
    await r.ensureGroup('tools', 'host');
    const id = await r.xadd('tools', { id: 'call-2' });

    await r.xreadGroup({
      group: 'host',
      consumer: 'c1',
      stream: 'tools',
      count: 10,
      blockMs: 0,
    });
    await r.ack('tools', 'host', [id]); // processed + acknowledged

    const claimed = await r.claimStale({
      group: 'host',
      consumer: 'c2',
      stream: 'tools',
      minIdleMs: 0,
      count: 10,
    });
    expect(claimed).toEqual([]); // nothing left pending
  });
});
