import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { InMemoryRedisStream } from '../../../_lib/redis/in-memory-redis-stream';
import { turnKeys } from '@shared/engine/redis-turn-keys';
import { TurnTransport } from '../turn-transport.service';

const TURN = 'T1';
const keys = turnKeys(TURN);

/**
 * A raw-`ioredis`-shaped double for the DEDICATED blocking connections (`openToolBridge`'s replies
 * reader, `readSteerInput`'s input tail). Backed by the SAME {@link InMemoryRedisStream} as the port so a
 * frame XADDed via the port is readable here — reshaping the port's `{id,data}` into ioredis' positional
 * `[[key, [[id, ['data', json]]]]]` reply that the reader/steer loop parse.
 */
class FakeRawRedis {
  constructor(private readonly store: InMemoryRedisStream) {}
  duplicate(): FakeRawRedis {
    return new FakeRawRedis(this.store);
  }
  disconnect(): void {}
  async xread(...args: unknown[]): Promise<unknown> {
    const blockIdx = args.indexOf('BLOCK');
    const blockMs = blockIdx >= 0 ? Number(args[blockIdx + 1]) : 0;
    const streamsIdx = args.indexOf('STREAMS');
    const stream = String(args[streamsIdx + 1]);
    const lastId = String(args[streamsIdx + 2]);
    const entries = await this.store.xread({
      stream,
      lastId,
      count: 100,
      blockMs,
    });
    if (entries.length === 0) return null;
    return [
      [stream, entries.map((e) => [e.id, ['data', JSON.stringify(e.data)]])],
    ];
  }
}

function make(): {
  store: InMemoryRedisStream;
  transport: TurnTransport;
} {
  const store = new InMemoryRedisStream();
  const raw = new FakeRawRedis(store);
  const transport = new TurnTransport(store, raw as unknown as Redis);
  return { store, transport };
}

/** Read the whole events stream as decoded frames. */
async function readEvents(store: InMemoryRedisStream): Promise<unknown[]> {
  const entries = await store.xread({
    stream: keys.events,
    lastId: '0',
    count: 100,
    blockMs: 0,
  });
  return entries.map((e) => e.data);
}

describe('TurnTransport', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('readSpec returns the single spec frame the host XADDed', async () => {
    const { store, transport } = make();
    await store.xadd(keys.spec, { turnId: TURN, engine: 'claude' });
    const spec = await transport.readSpec(TURN);
    expect(spec).toEqual({ turnId: TURN, engine: 'claude' });
  });

  it('readSpec throws when no spec was written', async () => {
    const { transport } = make();
    await expect(transport.readSpec(TURN)).rejects.toThrow(/no spec/);
  });

  it('emitEvent appends an { t:"event", e } frame to the events stream', async () => {
    const { store, transport } = make();
    transport.emitEvent(TURN, { kind: 'text', text: 'hi' } as never);
    // fire-and-forget, but the in-memory xadd writes synchronously
    await Promise.resolve();
    expect(await readEvents(store)).toEqual([
      { t: 'event', e: { kind: 'text', text: 'hi' } },
    ]);
  });

  it('emitFinal appends the terminal { t:"final", r } frame', async () => {
    const { store, transport } = make();
    await transport.emitFinal(TURN, { result: 'done' } as never);
    expect(await readEvents(store)).toEqual([
      { t: 'final', r: { result: 'done' } },
    ]);
  });

  it('emitError appends the terminal error frame verbatim', async () => {
    const { store, transport } = make();
    await transport.emitError(TURN, {
      t: 'error',
      message: 'boom',
      auth: true,
      engine: 'claude',
    });
    expect(await readEvents(store)).toEqual([
      { t: 'error', message: 'boom', auth: true, engine: 'claude' },
    ]);
  });

  it('startHeartbeat appends a heartbeat frame each interval (and is unref-safe)', async () => {
    vi.useFakeTimers();
    const { store, transport } = make();
    transport.startHeartbeat(TURN);
    await vi.advanceTimersByTimeAsync(5_000);
    const frames = (await readEvents(store)) as Array<{ t: string }>;
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames.every((f) => f.t === 'heartbeat')).toBe(true);
    await transport.cleanup();
  });

  it('onAbort fires the callback on a publish to the abort channel', async () => {
    const { store, transport } = make();
    let aborted = false;
    await transport.onAbort(TURN, () => {
      aborted = true;
    });
    await store.publish(keys.abort, { stop: true });
    expect(aborted).toBe(true);
    await transport.cleanup();
  });

  it('readSteerInput yields steers XADDed to the input stream', async () => {
    const { store, transport } = make();
    const { steerInput, stop } = transport.readSteerInput(TURN);
    const it = steerInput[Symbol.asyncIterator]();
    const nextP = it.next();
    await store.xadd(keys.input, { id: 's1', text: 'please add a test' });
    const { value } = await nextP;
    expect(value).toEqual({ id: 's1', text: 'please add a test' });
    stop();
  });

  it('openToolBridge round-trips a tool_request → tool_response by id', async () => {
    const { store, transport } = make();
    const bridge = transport.openToolBridge(TURN);
    const callP = bridge.call('read_file', { path: '/x' });

    // Act as the host: consume the tool_request, reply on the replies stream by id.
    const reqEntries = await store.xread({
      stream: keys.tools,
      lastId: '0',
      count: 1,
      blockMs: 1_000,
    });
    const req = reqEntries[0].data as {
      t: string;
      id: string;
      name: string;
      args: unknown;
    };
    expect(req).toMatchObject({
      t: 'tool_request',
      name: 'read_file',
      args: { path: '/x' },
    });
    await store.xadd(keys.replies, {
      t: 'tool_response',
      id: req.id,
      result: { contents: 'ok' },
    });

    await expect(callP).resolves.toEqual({ contents: 'ok' });
    bridge.close();
    await transport.cleanup();
  });

  it('openToolBridge rejects the call on a tool_error reply', async () => {
    const { store, transport } = make();
    const bridge = transport.openToolBridge(TURN);
    const callP = bridge.call('write_file', {});

    const reqEntries = await store.xread({
      stream: keys.tools,
      lastId: '0',
      count: 1,
      blockMs: 1_000,
    });
    const req = reqEntries[0].data as { id: string };
    await store.xadd(keys.replies, {
      t: 'tool_error',
      id: req.id,
      message: 'denied',
    });

    await expect(callP).rejects.toThrow(/denied/);
    bridge.close();
    await transport.cleanup();
  });
});
