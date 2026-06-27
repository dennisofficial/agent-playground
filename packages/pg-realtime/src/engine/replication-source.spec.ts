import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeEvent } from '../types';

/**
 * A controllable fake for pg-logical-replication's LogicalReplicationService.
 * Defined inside vi.hoisted so it's available to the (hoisted) vi.mock factory.
 * `instances` records every service the source constructs, so a test can assert
 * the connection lifecycle — most importantly that EVERY failed service is
 * stopped (its walsender released) and none are orphaned.
 */
const { FakeService, instances } = vi.hoisted(() => {
  const instances: FakeServiceT[] = [];

  class FakeServiceT {
    readonly handlers = new Map<string, (...args: unknown[]) => void>();
    stopCalls = 0;
    readonly acks: string[] = [];
    resolveSubscribe!: () => void;
    rejectSubscribe!: (err: unknown) => void;
    private readonly subscribePromise: Promise<void>;

    constructor(
      readonly clientConfig: unknown,
      readonly config: unknown,
    ) {
      this.subscribePromise = new Promise<void>((resolve, reject) => {
        this.resolveSubscribe = resolve;
        this.rejectSubscribe = reject;
      });
      instances.push(this);
    }

    on(event: string, cb: (...args: unknown[]) => void): this {
      this.handlers.set(event, cb);
      return this;
    }

    subscribe(): Promise<void> {
      return this.subscribePromise;
    }

    acknowledge(lsn: string): Promise<void> {
      this.acks.push(lsn);
      return Promise.resolve();
    }

    stop(): Promise<this> {
      this.stopCalls += 1;
      return Promise.resolve(this);
    }

    /** Drive an event the source registered via on(). */
    fire(event: string, ...args: unknown[]): void {
      this.handlers.get(event)?.(...args);
    }
  }

  return { FakeService: FakeServiceT, instances };
});

type FakeServiceT = InstanceType<typeof FakeService>;

vi.mock('pg-logical-replication', () => ({
  LogicalReplicationService: FakeService,
  PgoutputPlugin: class {
    constructor(_opts: unknown) {}
  },
  Pgoutput: {},
}));

// Imported AFTER the mock is declared (vi.mock is hoisted above this import).
import { ReplicationSource, type ReplicationSourceDeps } from './replication-source';

/** Flush pending microtasks (the .then / async handlers the source schedules). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const latest = (): FakeServiceT => instances[instances.length - 1];

function makeSource(over: Partial<ReplicationSourceDeps> = {}): {
  source: ReplicationSource;
  changes: ChangeEvent[];
} {
  const changes: ChangeEvent[] = [];
  const source = new ReplicationSource({
    connectionString: 'postgresql://user:pass@localhost:5432/db',
    slotName: 'test_slot',
    publicationName: 'test_pub',
    pkByTable: new Map([['public.threads', ['id']]]),
    onChange: (ev) => {
      changes.push(ev);
    },
    ...over,
  });
  return { source, changes };
}

beforeEach(() => {
  instances.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ReplicationSource connection lifecycle', () => {
  it('opens exactly one replication connection on start', async () => {
    const { source } = makeSource();
    await source.start();
    expect(instances).toHaveLength(1);
    expect(latest().stopCalls).toBe(0);
  });

  it('stops the failed service when subscribe rejects (releases the walsender)', async () => {
    const { source } = makeSource();
    await source.start();
    const failed = latest();

    // The "slot is active" rejection — exactly the dev hot-reload handoff case where
    // pg-logical-replication leaves the client (walsender) open.
    failed.rejectSubscribe(new Error('replication slot "test_slot" is active for PID 123'));
    await flush();

    expect(failed.stopCalls).toBe(1);
  });

  it('never leaks a walsender across repeated reconnects', async () => {
    const { source } = makeSource();
    await source.start();

    // Five failed reconnect cycles in a row (the scenario that piled up 19 zombie
    // walsenders before the fix).
    for (let i = 0; i < 5; i++) {
      latest().rejectSubscribe(new Error('replication slot "test_slot" is active for PID 123'));
      await flush();
      await vi.advanceTimersByTimeAsync(10_000); // fire the backoff timer → reconnect
      await flush();
    }

    // A fresh service was opened each cycle...
    expect(instances.length).toBeGreaterThan(5);
    // ...and at most ONE is still un-stopped: the latest, still-pending connection.
    // Every previous (failed) service was torn down — no orphaned walsenders.
    const unstopped = instances.filter((s) => s.stopCalls === 0);
    expect(unstopped).toEqual([latest()]);
  });

  it('reconnects after the stream ends, stopping the ended service', async () => {
    const { source } = makeSource();
    await source.start();
    const ended = latest();

    // subscribe() resolving means the stream ended (not an error).
    ended.resolveSubscribe();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();

    expect(ended.stopCalls).toBe(1);
    expect(instances).toHaveLength(2);
  });

  it('stop() tears down the active service and prevents further reconnects', async () => {
    const { source } = makeSource();
    await source.start();
    const svc = latest();

    await source.stop();
    expect(svc.stopCalls).toBe(1);

    // A late failure after stop() must NOT schedule a reconnect.
    svc.rejectSubscribe(new Error('connection terminated'));
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();

    expect(instances).toHaveLength(1);
  });
});

describe('ReplicationSource change delivery', () => {
  it('buffers a transaction and emits each change stamped with commitEndLsn, then acks', async () => {
    const { source, changes } = makeSource();
    await source.start();
    const svc = latest();

    const relation = { schema: 'public', name: 'threads', keyColumns: ['id'] };
    svc.fire('data', '0/10', { tag: 'begin' });
    svc.fire('data', '0/11', { tag: 'insert', relation, new: { id: 7, title: 'hi' } });
    await flush();
    svc.fire('data', '0/12', { tag: 'commit', commitEndLsn: '0/30' });
    await flush();

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      op: 'insert',
      table: 'threads',
      pk: JSON.stringify([7]),
      lsn: '0/30', // the transaction's commit LSN, not the per-message LSN
    });
    // Acknowledge only AFTER onChange (at-least-once delivery).
    expect(svc.acks).toEqual(['0/30']);
  });

  it('ignores changes to tables that are not watched', async () => {
    const { source, changes } = makeSource();
    await source.start();
    const svc = latest();

    const relation = { schema: 'public', name: 'audit_log', keyColumns: ['id'] };
    svc.fire('data', '0/10', { tag: 'begin' });
    svc.fire('data', '0/11', { tag: 'insert', relation, new: { id: 1 } });
    svc.fire('data', '0/12', { tag: 'commit', commitEndLsn: '0/30' });
    await flush();

    expect(changes).toHaveLength(0);
    expect(svc.acks).toEqual(['0/30']); // still advances the slot
  });

  it('acknowledges a primary keepalive only when a reply is requested', async () => {
    const { source } = makeSource();
    await source.start();
    const svc = latest();

    svc.fire('heartbeat', '0/40', 0, false);
    expect(svc.acks).toEqual([]);

    svc.fire('heartbeat', '0/41', 0, true);
    expect(svc.acks).toEqual(['0/41']);
  });
});
