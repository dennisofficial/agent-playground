import { Subject } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { LiveTurnStore } from './live-turn-store';
import type { LiveStreamFrame } from './live-turn-store';
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
    store.push(REPO, THREAD, {
      kind: 'tool_use',
      id: 'tu1',
      name: 'Read',
      input: { path: 'a' },
    });

    const snap = store.snapshot(REPO, THREAD)!;
    expect(snap.active).toBe(true);
    expect(snap.blocks.map((b) => b.kind)).toEqual([
      'thinking',
      'text',
      'tool',
    ]);
    expect(snap.blocks[1]).toMatchObject({
      kind: 'text',
      text: 'Hello',
      done: false,
    });
    expect(snap.blocks[2]).toMatchObject({
      kind: 'tool',
      name: 'Read',
      done: false,
    });

    // tool_result pairs with the open tool_use by id.
    store.push(REPO, THREAD, {
      kind: 'tool_result',
      id: 'tu1',
      result: 'contents',
      isError: false,
    });
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

  it('closes post-turn row registration once pending order rows are drained', () => {
    const store = new LiveTurnStore();
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'working' });

    expect(store.registerPostTurnRow(REPO, THREAD, 'notice-1')).toBe(true);
    expect(store.takePendingOrder(REPO, THREAD)).toEqual(['notice-1']);

    expect(store.registerPostTurnRow(REPO, THREAD, 'notice-2')).toBe(false);
    expect(store.snapshot(REPO, THREAD)).not.toBeNull();

    const registeredDuringTurnEnd: boolean[] = [];
    const sub = store.stream$.subscribe((frame) => {
      if ((frame.event as { kind?: string }).kind === 'turn_end') {
        registeredDuringTurnEnd.push(
          store.registerPostTurnRow(REPO, THREAD, 'notice-during-end'),
        );
      }
    });
    store.end(REPO, THREAD);
    sub.unsubscribe();
    expect(registeredDuringTurnEnd).toEqual([false]);

    store.push(REPO, THREAD, { kind: 'text_delta', text: 'next' });
    expect(store.registerPostTurnRow(REPO, THREAD, 'notice-3')).toBe(true);
  });

  it('tags an interrupt-aborted tool_result as `superseded` on the block AND the emitted live frame', () => {
    const store = new LiveTurnStore();
    const frames: LiveStreamFrame[] = [];
    store.stream$.subscribe((f) => frames.push(f));

    store.push(REPO, THREAD, {
      kind: 'tool_use',
      id: 'tu1',
      name: 'Bash',
      input: { command: 'echo hi' },
    });
    store.push(REPO, THREAD, {
      kind: 'tool_result',
      id: 'tu1',
      result: 'MCP error -32001: AbortError: interrupt',
      isError: true,
    });

    expect(store.snapshot(REPO, THREAD)!.blocks[0]).toMatchObject({
      kind: 'tool',
      isError: true,
      superseded: true,
      done: true,
    });
    const resultFrame = frames.find(
      (f) => (f.event as { kind?: string }).kind === 'tool_result',
    )!;
    expect(
      (resultFrame.event as { superseded?: boolean }).superseded,
    ).toBe(true);
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
    store.push(REPO, THREAD, {
      kind: 'tool_use',
      id: 'tu1',
      name: 'Read',
      input: {},
    });

    const snap = store.snapshot(REPO, THREAD)!;
    // Exactly one thinking + one text block (pre-fix this was thinking,text,thinking,text — the dup).
    expect(snap.blocks.map((b) => b.kind)).toEqual([
      'thinking',
      'text',
      'tool',
    ]);
    expect(snap.blocks[0]).toMatchObject({
      kind: 'thinking',
      text: 'reasoning',
      done: true,
    });
    expect(snap.blocks[1]).toMatchObject({
      kind: 'text',
      text: 'Hello',
      done: true,
    });
  });

  it('ignores malformed user_text frames without a subagent parent or visible text', () => {
    const store = new LiveTurnStore();

    store.push(REPO, THREAD, {
      kind: 'user_text',
      text: 'main-thread steer echo must not render here',
    });
    store.push(REPO, THREAD, {
      kind: 'user_text',
      text: '   ',
      parentToolUseId: 'tu-sub-ignored',
    });

    expect(store.snapshot(REPO, THREAD)!.blocks).toHaveLength(0);
  });
});

describe('LiveTurnStore — silent reset (orphaned-turn reattach rebuilds a CLEAN lane)', () => {
  it('reset drops the lane WITHOUT fanning a turn_end (unlike end)', () => {
    const store = new LiveTurnStore();
    const frames: LiveStreamFrame[] = [];
    const sub = store.stream$.subscribe((f) => frames.push(f));

    store.push(REPO, THREAD, { kind: 'text_delta', text: 'Hel' });
    expect(store.snapshot(REPO, THREAD)).not.toBeNull();

    store.reset(REPO, THREAD);
    sub.unsubscribe();

    // The lane is gone, and — crucially — no turn_end frame was fanned (which would race the client's
    // async reconcileNow().then(endLiveTurn)). Contrast with `end`, which DOES emit turn_end.
    expect(store.snapshot(REPO, THREAD)).toBeNull();
    expect(
      frames.some((f) => (f.event as { kind?: string }).kind === 'turn_end'),
    ).toBe(false);
  });

  it('end DOES fan a turn_end (the contrast that makes reset’s silence meaningful)', () => {
    const store = new LiveTurnStore();
    const frames: LiveStreamFrame[] = [];
    const sub = store.stream$.subscribe((f) => frames.push(f));

    store.push(REPO, THREAD, { kind: 'text_delta', text: 'Hel' });
    store.end(REPO, THREAD);
    sub.unsubscribe();

    expect(
      frames.some((f) => (f.event as { kind?: string }).kind === 'turn_end'),
    ).toBe(true);
  });

  it('strand → reset → replay rebuilds ONE open text block + a fresh turn_start (baseline strands two)', () => {
    // BASELINE (no reset): a prior subscription died with an open text block stranded on the lane; the
    // reattach replays the turn's history from '0-0' (an adaptive-thinking interleave: thinking then text)
    // ONTO that strand — so the stranded text and the replayed text both sit open at once (two carets).
    const baseline = new LiveTurnStore();
    baseline.push(REPO, THREAD, { kind: 'text_delta', text: 'stranded' }); // prior life, never finalized
    baseline.push(REPO, THREAD, { kind: 'thinking_delta', text: 'plan' }); // replay from '0-0'
    baseline.push(REPO, THREAD, { kind: 'text_delta', text: 'fresh' });
    const strandedOpenText = baseline
      .snapshot(REPO, THREAD)!
      .blocks.filter((b) => b.kind === 'text' && !b.done);
    expect(strandedOpenText).toHaveLength(2); // the bug: two open text blocks

    // FIXED (reset before replay): the strand is cleared, so the replay rebuilds exactly what its events
    // describe — one open text block — and, because the lane is now empty, the first push fans a fresh
    // turn_start (isNew).
    const store = new LiveTurnStore();
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'stranded' }); // prior life
    store.reset(REPO, THREAD);

    const frames: LiveStreamFrame[] = [];
    const sub = store.stream$.subscribe((f) => frames.push(f));
    store.push(REPO, THREAD, { kind: 'thinking_delta', text: 'plan' }); // replay from '0-0'
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'fresh' });
    sub.unsubscribe();

    const openText = store
      .snapshot(REPO, THREAD)!
      .blocks.filter((b) => b.kind === 'text' && !b.done);
    expect(openText).toHaveLength(1);
    expect(openText[0].text).toBe('fresh');
    // A fresh turn_start fired after the reset (isNew) so a connected client rebuilds cleanly.
    expect(
      frames.some((f) => (f.event as { kind?: string }).kind === 'turn_start'),
    ).toBe(true);
  });
});

describe('LiveTurnStore — background subagent settlement (bg_task marks the anchor, survives reconnect)', () => {
  // A backgrounded Task subagent's own `tool_result` is an IMMEDIATE launch ack (done=true), not the real
  // completion — so `done` alone would show the card "done" while it still streams. The subagent's real
  // completion arrives later as a `bg_task` settlement carrying the spawning Task id (== the anchor toolId);
  // the store must stamp `bgSettled` on the anchor and carry it in the cumulative snapshot (raw bg_task
  // frames are NOT replayed on reconnect).
  it('a bg_task settlement stamps bgSettled on the matching anchor tool block', () => {
    const store = new LiveTurnStore();
    store.push(REPO, THREAD, {
      kind: 'tool_use',
      id: 'tu-bg',
      name: 'Task',
      input: { subagent_type: 'general-purpose', run_in_background: true },
    });
    // The immediate launch ack: the anchor flips done=true but is NOT finished.
    store.push(REPO, THREAD, {
      kind: 'tool_result',
      id: 'tu-bg',
      result: 'launched',
      isError: false,
    });
    // The subagent streams its own work under the anchor's id.
    store.push(REPO, THREAD, {
      kind: 'text_delta',
      text: 'working',
      parentToolUseId: 'tu-bg',
    });

    let anchor = store
      .snapshot(REPO, THREAD)!
      .blocks.find((b) => b.toolId === 'tu-bg')!;
    expect(anchor).toMatchObject({ done: true });
    expect(anchor.bgSettled).toBeUndefined(); // still running despite done=true

    // Real completion arrives as a bg_task settlement carrying the spawning Task id.
    store.push(REPO, THREAD, {
      kind: 'bg_task',
      status: 'completed',
      parentToolUseId: 'tu-bg',
    });

    anchor = store
      .snapshot(REPO, THREAD)!
      .blocks.find((b) => b.toolId === 'tu-bg')!;
    expect(anchor.bgSettled).toBe(true);
  });

  it('a bg_task "started" (no settlement) leaves the anchor unsettled', () => {
    const store = new LiveTurnStore();
    store.push(REPO, THREAD, {
      kind: 'tool_use',
      id: 'tu-bg',
      name: 'Task',
      input: { run_in_background: true },
    });
    store.push(REPO, THREAD, {
      kind: 'tool_result',
      id: 'tu-bg',
      result: 'launched',
      isError: false,
    });
    store.push(REPO, THREAD, {
      kind: 'bg_task',
      status: 'started',
      parentToolUseId: 'tu-bg',
    });

    const anchor = store
      .snapshot(REPO, THREAD)!
      .blocks.find((b) => b.toolId === 'tu-bg')!;
    expect(anchor.bgSettled).toBeUndefined();
  });
});

describe('LiveTurnStore — server emittedAt stamps (lets the web time-merge live blocks vs durable rows)', () => {
  it('fans a strictly-increasing emittedAt on each block-creating delta, mirrored inside event.emittedAt', () => {
    const store = new LiveTurnStore();
    const frames: LiveStreamFrame[] = [];
    const sub = store.stream$.subscribe((f) => frames.push(f));

    store.push(REPO, THREAD, { kind: 'text_delta', text: 'Hi' });
    store.push(REPO, THREAD, {
      kind: 'tool_use',
      id: 'tu1',
      name: 'Read',
      input: {},
    });
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'bye' });
    sub.unsubscribe();

    // turn_start creates no block and carries no stamp; every block-creating delta frame does.
    const delta = frames.filter(
      (f) => (f.event as { kind: string }).kind !== 'turn_start',
    );
    expect(delta).toHaveLength(3);
    for (const f of delta) {
      expect(typeof f.emittedAt).toBe('number');
      // The stamp is embedded inside `event` too, so it reaches the web through the verbatim controller fan.
      expect((f.event as { emittedAt?: number }).emittedAt).toBe(f.emittedAt);
    }
    const stamps = delta.map((f) => f.emittedAt as number);
    for (let i = 1; i < stamps.length; i++)
      expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);

    // The turn_start frame creates no block, so it carries no stamp.
    const start = frames.find(
      (f) => (f.event as { kind: string }).kind === 'turn_start',
    );
    expect(start!.emittedAt).toBeUndefined();
  });

  it('snapshot blocks each carry an emittedAt, monotonic in block order', () => {
    const store = new LiveTurnStore();
    store.push(REPO, THREAD, { kind: 'thinking', text: 'reasoning' });
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'Hello' });
    store.push(REPO, THREAD, {
      kind: 'tool_use',
      id: 'tu1',
      name: 'Read',
      input: {},
    });

    const blocks = store.snapshot(REPO, THREAD)!.blocks;
    expect(blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool']);
    for (const b of blocks) expect(typeof b.emittedAt).toBe('number');
    for (let i = 1; i < blocks.length; i++)
      expect(blocks[i].emittedAt).toBeGreaterThan(blocks[i - 1].emittedAt);
  });

  it('appending text to an OPEN block keeps its emittedAt as the block start time (the ordering key)', () => {
    const store = new LiveTurnStore();
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'Hel' });
    const startStamp = store.snapshot(REPO, THREAD)!.blocks[0].emittedAt;
    // A second delta appends to the SAME open block — it must not re-stamp the block.
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'lo' });

    const block = store.snapshot(REPO, THREAD)!.blocks[0];
    expect(block).toMatchObject({ kind: 'text', text: 'Hello' });
    expect(block.emittedAt).toBe(startStamp);
  });

  it('reuses the block emittedAt for frames that only update an existing block', () => {
    const store = new LiveTurnStore();
    const frames: LiveStreamFrame[] = [];
    const sub = store.stream$.subscribe((f) => frames.push(f));

    store.push(REPO, THREAD, { kind: 'text_delta', text: 'Hel' });
    const startStamp = store.snapshot(REPO, THREAD)!.blocks[0].emittedAt;
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'lo' });
    store.push(REPO, THREAD, { kind: 'text', text: 'Hello' });
    store.push(REPO, THREAD, {
      kind: 'tool_use',
      id: 'tu1',
      name: 'Read',
      input: {},
    });
    const toolStamp = store.snapshot(REPO, THREAD)!.blocks[1].emittedAt;
    store.push(REPO, THREAD, {
      kind: 'tool_result',
      id: 'tu1',
      result: 'contents',
      isError: false,
    });
    sub.unsubscribe();

    const append = frames.find(
      (f) => (f.event as { text?: string }).text === 'lo',
    )!;
    expect(append.emittedAt).toBe(startStamp);
    expect((append.event as { emittedAt?: number }).emittedAt).toBe(startStamp);

    const finalize = frames.find(
      (f) => (f.event as { kind?: string }).kind === 'text',
    )!;
    expect(finalize.emittedAt).toBe(startStamp);
    expect((finalize.event as { emittedAt?: number }).emittedAt).toBe(
      startStamp,
    );
    expect(store.snapshot(REPO, THREAD)!.blocks[0].emittedAt).toBe(startStamp);

    const toolResult = frames.find(
      (f) => (f.event as { kind?: string }).kind === 'tool_result',
    )!;
    expect(toolResult.emittedAt).toBe(toolStamp);
    expect((toolResult.event as { emittedAt?: number }).emittedAt).toBe(
      toolStamp,
    );
  });
});

describe('SSE resume — a late subscriber (reconnect mid-turn) catches up via snapshot, then streams live', () => {
  function makeController(liveTurns: LiveTurnStore) {
    const surface = {
      outbound$: new Subject<WebOutboundMessage>(),
      threadMeta$: new Subject<{
        channel: string;
        jobId: string;
        title: string;
      }>(),
      messagesChanged$: new Subject<{ channel: string; jobId: string }>(),
    };
    return new WebSurfaceController(
      surface as never, // surface (outbound$ + threadMeta$)
      liveTurns,
      {} as never, // driverStore
      {} as never, // threadLifecycle
      {} as never, // autoMerge
      {} as never, // orgService
      {} as never, // threads
      {} as never, // messages
      {} as never, // repos
      {} as never, // subagents
      {} as never, // threadTitle
      { stream$: new Subject() } as never, // usageBus
      { available: false } as never, // realtime
      {
        isLeader: () => true,
        getState: () => 'leader',
        isDraining: () => false,
      } as never, // election
      { dispatch: async () => undefined } as never, // dispatcher (JOB_DISPATCHER)
      {
        write: async () => undefined,
        list: async () => [],
        listForRepo: async () => [],
        read: async () => null,
      } as never, // secrets (WorkspaceSecretFileStore)
      {} as never, // store (BrainStoreService)
      { stopTurn: async () => false } as never, // brain (AgentSessionManager)
      {} as never, // mcpStore (McpServerStore)
      {} as never, // mcpProbe (McpProbeService)
      {} as never, // conventions (ConventionProfileResolver)
      {} as never, // skillStore (WorkspaceSkillStore)
      {} as never, // skillFiles (SkillFileWriter)
      {} as never, // skillInstaller (SkillInstallerService)
      {} as never, // git (LocalGitService)
      {} as never, // jobDeps (JobDependencyService)
      {} as never, // driverApproval (DriverApprovalGateway)
      {} as never, // intake (StimulusIntake)
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
      .events('org-1', REPO)
      .subscribe((m: MessageEvent) =>
        frames.push(m.data as Record<string, unknown>),
      );

    // 1) The FIRST thing it receives is a snapshot reflecting everything streamed so far ("Hello").
    const snapshotFrame = frames.find(
      (f) =>
        f.type === 'stream' &&
        (f.event as { kind?: string }).kind === 'snapshot',
    );
    expect(snapshotFrame).toBeDefined();
    const snapEvent = snapshotFrame!.event as {
      blocks: Array<{ kind: string; text?: string }>;
      active: boolean;
    };
    expect(snapEvent.active).toBe(true);
    expect(snapEvent.blocks[0]).toMatchObject({ kind: 'text', text: 'Hello' });
    const snapSeq = snapshotFrame!.seq as number;

    // 2) Subsequent deltas arrive live, with seq AFTER the snapshot (so the client appends, not dupes).
    store.push(REPO, THREAD, { kind: 'text_delta', text: ' world' });
    const deltaFrame = frames.find(
      (f) =>
        f.type === 'stream' &&
        (f.event as { kind?: string }).kind === 'text_delta',
    );
    expect(deltaFrame).toBeDefined();
    expect((deltaFrame!.event as { text: string }).text).toBe(' world');
    expect(deltaFrame!.seq as number).toBeGreaterThan(snapSeq);

    // 3) turn_end is forwarded so the client reconciles against the durable log.
    store.end(REPO, THREAD);
    const endFrame = frames.find(
      (f) =>
        f.type === 'stream' &&
        (f.event as { kind?: string }).kind === 'turn_end',
    );
    expect(endFrame).toBeDefined();

    sub.unsubscribe();
  });

  it('emittedAt rides the real SSE wire — on snapshot blocks AND on each live delta frame event', async () => {
    const store = new LiveTurnStore();
    const controller = makeController(store);

    // A turn is already in flight before this client connects — its cumulative blocks carry emittedAt.
    store.push(REPO, THREAD, { kind: 'text_delta', text: 'Hi' });

    const frames: Array<Record<string, unknown>> = [];
    const sub = controller
      .events('org-1', REPO)
      .subscribe((m: MessageEvent) =>
        frames.push(m.data as Record<string, unknown>),
      );

    // 1) The snapshot the controller fans (blocks: s.blocks) carries emittedAt on each block.
    const snapshotFrame = frames.find(
      (f) =>
        f.type === 'stream' &&
        (f.event as { kind?: string }).kind === 'snapshot',
    );
    const snapBlocks = (
      snapshotFrame!.event as { blocks: Array<{ emittedAt?: number }> }
    ).blocks;
    expect(typeof snapBlocks[0].emittedAt).toBe('number');

    // 2) A subsequent live delta (event: f.event, forwarded verbatim) carries emittedAt inside event.
    store.push(REPO, THREAD, {
      kind: 'tool_use',
      id: 'tu1',
      name: 'Read',
      input: {},
    });
    const deltaFrame = frames.find(
      (f) =>
        f.type === 'stream' &&
        (f.event as { kind?: string }).kind === 'tool_use',
    );
    const deltaEvent = deltaFrame!.event as { emittedAt?: number };
    expect(typeof deltaEvent.emittedAt).toBe('number');
    // The live block's stamp is strictly after the earlier snapshot block's (monotonic across the turn).
    expect(deltaEvent.emittedAt!).toBeGreaterThan(snapBlocks[0].emittedAt!);

    sub.unsubscribe();
  });

  it('a client connecting AFTER the turn ended gets no stale snapshot (durable /messages covers it)', () => {
    const store = new LiveTurnStore();
    const controller = makeController(store);
    store.push(REPO, THREAD, { kind: 'text', text: 'done' });
    store.end(REPO, THREAD);

    const frames: Array<Record<string, unknown>> = [];
    const sub = controller
      .events('org-1', REPO)
      .subscribe((m: MessageEvent) =>
        frames.push(m.data as Record<string, unknown>),
      );
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
    expect(phase.blocks[0]).toMatchObject({
      kind: 'text',
      text: 'replythinking',
    });

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
    store.push(REPO, THREAD, {
      kind: 'text_delta',
      text: 'sub',
      parentToolUseId: 'tu-9',
    });
    const snap = store.snapshot(REPO, THREAD)!;
    expect(snap.blocks).toHaveLength(2);
    expect(snap.blocks[0]).toMatchObject({
      text: 'main',
      parentToolUseId: undefined,
    });
    expect(snap.blocks[1]).toMatchObject({
      text: 'sub',
      parentToolUseId: 'tu-9',
    });
  });
});
