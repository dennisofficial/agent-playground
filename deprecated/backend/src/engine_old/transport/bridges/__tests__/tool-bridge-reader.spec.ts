import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolBridgeReader } from '../tool-bridge-reader';

type Waiter = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

class FakeBlockingRedis {
  private entries: Array<[string, string[]]> = [];
  private seq = 0;
  private waiter?: Waiter;

  xread(): Promise<unknown> {
    if (this.entries.length > 0) return Promise.resolve([['replies', this.entries.splice(0)]]);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  disconnect(): void {
    this.failPendingRead(new Error('connection closed'));
  }

  failPendingRead(err: Error): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(err);
  }

  pushFrame(frame: unknown): void {
    this.pushFields(['data', JSON.stringify(frame)]);
  }

  pushFields(fields: string[]): void {
    this.entries.push([`${++this.seq}-0`, fields]);
    this.flushWaiter();
  }

  private flushWaiter(): void {
    if (!this.waiter || this.entries.length === 0) return;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter.resolve([['replies', this.entries.splice(0)]]);
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function startReader(redis = new FakeBlockingRedis()): {
  logs: string[];
  reader: ToolBridgeReader;
  redis: FakeBlockingRedis;
} {
  const logs: string[] = [];
  const reader = new ToolBridgeReader({
    repliesKey: 'replies',
    makeSub: () => redis,
    log: (msg) => logs.push(msg),
  });
  reader.start();
  return { logs, reader, redis };
}

describe('ToolBridgeReader', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not start the heartbeat-gap timer until the host marks the call in flight', async () => {
    vi.useFakeTimers();
    const { reader, redis } = startReader();
    const p = reader.register('queued-call');
    let settled = false;
    void p.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(91_000);
    await flushPromises();
    expect(settled).toBe(false);

    redis.pushFrame({ t: 'tool_progress', id: 'queued-call', ts: Date.now() });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(89_999);
    await flushPromises();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    await expect(p).rejects.toThrow(/no heartbeat/);
    reader.stopReader();
  });

  it('skips malformed frames without rejecting the matching pending call', async () => {
    vi.useFakeTimers();
    const { logs, reader, redis } = startReader();
    const p = reader.register('call-1');

    redis.pushFrame({
      t: 'not_a_real_frame',
      id: 'call-1',
      message: 'do not reject with this',
    });
    await flushPromises();
    redis.pushFrame({ t: 'tool_response', id: 'call-1', result: { ok: true } });

    await expect(p).resolves.toEqual({ ok: true });
    expect(logs).toContain('tool-bridge reader got malformed frame (skipping)');
    reader.stopReader();
  });

  it('continues after a transient xread failure and delivers the later reply', async () => {
    vi.useFakeTimers();
    const { logs, reader, redis } = startReader();
    const p = reader.register('call-1');

    redis.failPendingRead(new Error('temporary xread failure'));
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    redis.pushFrame({ t: 'tool_response', id: 'call-1', result: 'ok' });

    await expect(p).resolves.toBe('ok');
    expect(logs.some((line) => line.includes('tool-bridge reader xread failed'))).toBe(true);
    reader.stopReader();
  });
});
