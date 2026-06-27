import { Subject } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { LiveTurnStore } from './live-turn-store';
import { WebSurfaceController } from './web-surface.controller';
import type { WebOutboundMessage } from './web-surface';

/**
 * RESUMABLE/DURABLE STREAMING — the core guarantee: a client that connects MID-TURN (refresh,
 * navigate-back, network blip) catches up to the current state and keeps streaming, because the
 * producing turn runs independent of any connection and its cumulative state lives in `LiveTurnStore`.
 */

const REPO = 'repo-1';
const THREAD = 'thread-1';

describe('LiveTurnStore — cumulative in-flight turn', () => {
  it('accumulates deltas into blocks; snapshot reflects current state; end clears it', () => {
    const store = new LiveTurnStore();
    store.push(REPO, THREAD, { kind: 'thinking', text: 'reasoning' });
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'Hel' });
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'lo' });
    store.push(REPO, THREAD, { kind: 'tool_use', id: 'tu1', name: 'Read', input: { path: 'a' } });

    const snap = store.snapshot(REPO, THREAD)!;
    expect(snap.active).toBe(true);
    expect(snap.blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool']);
    expect(snap.blocks[1]).toMatchObject({ kind: 'text', text: 'Hello', done: false });
    expect(snap.blocks[2]).toMatchObject({ kind: 'tool', name: 'Read', done: false });

    // tool_result pairs with the open tool_use by id.
    store.push(REPO, THREAD, { kind: 'tool_result', id: 'tu1', result: 'contents', isError: false });
    expect(store.snapshot(REPO, THREAD)!.blocks[2]).toMatchObject({
      kind: 'tool',
      result: 'contents',
      isError: false,
      done: true,
    });

    // seq is monotonic; snapshot carries the latest.
    expect(store.snapshot(REPO, THREAD)!.seq).toBeGreaterThan(0);

    store.end(REPO, THREAD);
    expect(store.snapshot(REPO, THREAD)).toBeNull();
    expect(store.snapshotsForRepo(REPO)).toHaveLength(0);
  });
});

describe('SSE resume — a late subscriber (reconnect mid-turn) catches up via snapshot, then streams live', () => {
  function makeController(liveTurns: LiveTurnStore) {
    const surface = {
      outbound$: new Subject<WebOutboundMessage>(),
      threadMeta$: new Subject<{ channel: string; threadId: string; title: string }>(),
    };
    return new WebSurfaceController(
      surface as never, // surface (outbound$ + threadMeta$)
      liveTurns,
      {} as never, // driverStore
      {} as never, // threadLifecycle
      {} as never, // orgService
      {} as never, // threads
      {} as never, // messages
      {} as never, // repos
      {} as never, // threadTitle
      { stream$: new Subject() } as never, // ticketEvents
      { available: false } as never, // realtime
    );
  }

  it('replays the current turn on connect, then forwards subsequent deltas and turn_end', async () => {
    const store = new LiveTurnStore();
    const controller = makeController(store);

    // A turn is already in flight BEFORE this client connects (producer runs independent of the client).
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'Hel' });
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'lo' });

    // The client connects (reconnect) → subscribe to the repo SSE.
    const frames: Array<Record<string, unknown>> = [];
    const sub = controller
      .events(REPO)
      .subscribe((m: MessageEvent) => frames.push(m.data as Record<string, unknown>));

    // 1) The FIRST thing it receives is a snapshot reflecting everything streamed so far ("Hello").
    const snapshotFrame = frames.find(
      (f) => f.type === 'stream' && (f.event as { kind?: string }).kind === 'snapshot',
    );
    expect(snapshotFrame).toBeDefined();
    const snapEvent = snapshotFrame!.event as { blocks: Array<{ kind: string; text?: string }>; active: boolean };
    expect(snapEvent.active).toBe(true);
    expect(snapEvent.blocks[0]).toMatchObject({ kind: 'text', text: 'Hello' });
    const snapSeq = snapshotFrame!.seq as number;

    // 2) Subsequent deltas arrive live, with seq AFTER the snapshot (so the client appends, not dupes).
    store.push(REPO, THREAD, { kind: 'text_delta', text: ' world' });
    const deltaFrame = frames.find(
      (f) => f.type === 'stream' && (f.event as { kind?: string }).kind === 'text_delta',
    );
    expect(deltaFrame).toBeDefined();
    expect((deltaFrame!.event as { text: string }).text).toBe(' world');
    expect(deltaFrame!.seq as number).toBeGreaterThan(snapSeq);

    // 3) turn_end is forwarded so the client reconciles against the durable log.
    store.end(REPO, THREAD);
    const endFrame = frames.find(
      (f) => f.type === 'stream' && (f.event as { kind?: string }).kind === 'turn_end',
    );
    expect(endFrame).toBeDefined();

    sub.unsubscribe();
  });

  it('a client connecting AFTER the turn ended gets no stale snapshot (durable /messages covers it)', () => {
    const store = new LiveTurnStore();
    const controller = makeController(store);
    store.push(REPO, THREAD, { kind: 'text', text: 'done' });
    store.end(REPO, THREAD);

    const frames: Array<Record<string, unknown>> = [];
    const sub = controller.events(REPO).subscribe((m: MessageEvent) => frames.push(m.data as Record<string, unknown>));
    expect(frames.filter((f) => f.type === 'stream')).toHaveLength(0);
    sub.unsubscribe();
  });
});
