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

  it('interleaved thinking: authoritative text/thinking finalize their OPEN delta block, not the last one (no double stream)', () => {
    const store = new LiveTurnStore();
    // Adaptive thinking interleaves a thinking block before the text block, so BOTH stream open at once:
    // deltas build [thinking(open), text(open)]. The authoritative events then arrive in content order.
    store.push(REPO, THREAD, { kind: 'thinking_delta', text: 'reason' });
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'Hel' });
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'lo' });
    // Authoritative blocks close each open block by KIND — not by "last" (which pushed dupes before the fix).
    store.push(REPO, THREAD, { kind: 'thinking', text: 'reasoning' });
    store.push(REPO, THREAD, { kind: 'text', text: 'Hello' });
    store.push(REPO, THREAD, { kind: 'tool_use', id: 'tu1', name: 'Read', input: {} });

    const snap = store.snapshot(REPO, THREAD)!;
    // Exactly one thinking + one text block (pre-fix this was thinking,text,thinking,text — the dup).
    expect(snap.blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool']);
    expect(snap.blocks[0]).toMatchObject({ kind: 'thinking', text: 'reasoning', done: true });
    expect(snap.blocks[1]).toMatchObject({ kind: 'text', text: 'Hello', done: true });
  });
});

describe('SSE resume — a late subscriber (reconnect mid-turn) catches up via snapshot, then streams live', () => {
  function makeController(liveTurns: LiveTurnStore) {
    const surface = {
      outbound$: new Subject<WebOutboundMessage>(),
      threadMeta$: new Subject<{ channel: string; jobId: string; title: string }>(),
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
      { isLeader: () => true, getState: () => 'leader', isDraining: () => false } as never, // election
      { dispatch: async () => undefined } as never, // dispatcher (JOB_DISPATCHER)
      { write: async () => undefined, grant: async () => undefined } as never, // secrets (WorktreeSecretStore)
      {} as never, // store (BrainStoreService)
      { stopTurn: async () => false } as never, // brain (AgentSessionManager)
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

describe('LiveTurnStore — lanes (a brain turn and a build turn coexist on one thread)', () => {
  const PHASE = 'phase:step-7';

  it('two lanes on the same thread accumulate independently and do not clobber each other', () => {
    const store = new LiveTurnStore();
    // The brain turn (default `main` lane) and a build turn (a `phase:` lane) interleave on ONE thread.
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'brain ' });
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'reply' }, PHASE); // wrong-author would merge here if no lane
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'thinking' }, PHASE);
    store.push(REPO, THREAD, { kind: 'text_delta', text: '!' });

    const main = store.snapshot(REPO, THREAD)!; // default lane
    const phase = store.snapshot(REPO, THREAD, PHASE)!;
    expect(main.lane).toBe('main');
    expect(phase.lane).toBe(PHASE);
    expect(main.blocks).toHaveLength(1);
    expect(main.blocks[0]).toMatchObject({ kind: 'text', text: 'brain !' });
    expect(phase.blocks[0]).toMatchObject({ kind: 'text', text: 'replythinking' });

    // Ending one lane leaves the other intact.
    store.end(REPO, THREAD, PHASE);
    expect(store.snapshot(REPO, THREAD, PHASE)).toBeNull();
    expect(store.snapshot(REPO, THREAD)).not.toBeNull();
  });

  it('snapshotsForRepo returns one snapshot PER (thread, lane), each carrying its lane', () => {
    const store = new LiveTurnStore();
    store.push(REPO, THREAD, { kind: 'text', text: 'a' });
    store.push(REPO, THREAD, { kind: 'text', text: 'b' }, PHASE);
    const snaps = store.snapshotsForRepo(REPO);
    expect(snaps).toHaveLength(2);
    expect(new Set(snaps.map((s) => s.lane))).toEqual(new Set(['main', PHASE]));
    expect(snaps.every((s) => s.jobId === THREAD)).toBe(true);
  });

  it('a snapshot preserves parentToolUseId so subagent ownership survives a mid-turn reconnect', () => {
    const store = new LiveTurnStore();
    // Brain text, then a subagent's forwarded text (different author) — must NOT merge into one block.
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'main' });
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'sub', parentToolUseId: 'tu-9' });
    const snap = store.snapshot(REPO, THREAD)!;
    expect(snap.blocks).toHaveLength(2);
    expect(snap.blocks[0]).toMatchObject({ text: 'main', parentToolUseId: undefined });
    expect(snap.blocks[1]).toMatchObject({ text: 'sub', parentToolUseId: 'tu-9' });
  });
});
