import { describe, expect, it, vi } from 'vitest';
import { LiveTurnStore } from './live-turn-store';
import { type BlockSink, TurnHarnessFactory } from './turn-harness.service';

/**
 * The shared transcript spine — converts an engine turn's events into a live lane push + durable blocks.
 * Lifted verbatim from the brain's former `makeTurnStreamer`; these lock the role-parameterization
 * (lane + metaTag) and the idempotent finalization (finish/abort run once; late events are dropped).
 */
function setup() {
  const live = new LiveTurnStore();
  const persisted: Array<{ threadId: string; block: { kind: string; text?: string; meta?: Record<string, unknown> | null } }> = [];
  const sink: BlockSink = {
    appendBlock: vi.fn(async (threadId, block) => {
      persisted.push({ threadId, block });
    }),
  };
  return { live, persisted, factory: new TurnHarnessFactory(live, sink) };
}

describe('TurnHarnessFactory — the shared transcript spine', () => {
  it('finish: streams live then persists authoritative blocks tagged with the role metaTag, and ends the lane', async () => {
    const { live, persisted, factory } = setup();
    const h = factory.create({ threadId: 'T', channel: 'R', lane: 'phase:s1', metaTag: { phaseId: 's1', batchOrdinal: 2 } });
    h.onEvent({ kind: 'thinking', text: 'plan' });
    h.onEvent({ kind: 'text', text: 'hi' });
    h.onEvent({ kind: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a' } });
    h.onEvent({ kind: 'tool_result', id: 't1', result: 'ok' });

    // DURING the turn the live lane is the sole source of in-flight blocks.
    expect(live.snapshot('R', 'T', 'phase:s1')!.blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool']);

    await h.finish('hi');

    // Authoritative blocks persisted at turn END, every one tagged with the phase metaTag.
    expect(persisted.map((p) => p.block.kind)).toEqual(['thinking', 'chat', 'tool']);
    expect(persisted.every((p) => p.block.meta?.phaseId === 's1' && p.block.meta?.batchOrdinal === 2)).toBe(true);
    const tool = persisted.find((p) => p.block.kind === 'tool')!;
    expect(tool.block.meta).toMatchObject({ name: 'Edit', result: 'ok', phaseId: 's1' });
    // Lane ended (the durable rows now take over).
    expect(live.snapshot('R', 'T', 'phase:s1')).toBeNull();
  });

  it('abort: persists partials, ends the lane, is idempotent, and drops late events', async () => {
    const { live, persisted, factory } = setup();
    const h = factory.create({ threadId: 'T', channel: 'R', lane: 'phase:s1', metaTag: { phaseId: 's1' } });
    h.onEvent({ kind: 'text', text: 'partial' });
    await h.abort();

    expect(persisted.map((p) => p.block.kind)).toEqual(['chat']);
    expect(live.snapshot('R', 'T', 'phase:s1')).toBeNull();

    // A second finalize (e.g. a finally after a catch) is a no-op, and a late event after close is dropped.
    await h.finish('ignored');
    await h.abort();
    h.onEvent({ kind: 'text', text: 'late' });
    expect(persisted).toHaveLength(1);
  });

  it('brain lane (no metaTag): blocks carry no phase tag; a subagent block keeps its parentToolUseId', async () => {
    const { persisted, factory } = setup();
    const h = factory.create({ threadId: 'T', channel: 'R' }); // default `main` lane, no metaTag
    h.onEvent({ kind: 'text', text: 'brain' });
    h.onEvent({ kind: 'text', text: 'sub', parentToolUseId: 'tu1' });
    await h.finish();

    expect(persisted[0].block.meta).toBeUndefined();
    expect(persisted[1].block.meta).toEqual({ parentToolUseId: 'tu1' });
  });

  it('finish text fallback: a turn that emitted no text persists the final report as a chat block', async () => {
    const { persisted, factory } = setup();
    const h = factory.create({ threadId: 'T', channel: 'R', lane: 'phase:s1', metaTag: { phaseId: 's1' } });
    h.onEvent({ kind: 'tool_use', id: 't1', name: 'Bash', input: {} });
    h.onEvent({ kind: 'tool_result', id: 't1', result: 'done' });
    await h.finish('summary report');
    const chat = persisted.find((p) => p.block.kind === 'chat');
    expect(chat?.block.text).toBe('summary report');
    expect(chat?.block.meta).toMatchObject({ phaseId: 's1' });
  });
});
