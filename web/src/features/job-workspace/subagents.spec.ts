import type { JobMessage } from '@/lib/api/job-api';
import type { LiveBlock } from '@/lib/api/job-stream';
import { describe, expect, it } from 'vitest';
import {
  durableSubBlocks,
  indexDurableSubagents,
  indexLiveSubagents,
  liveSubBlocksForParent,
} from './subagents';

/**
 * The subagent card's live "running vs done" state.
 *
 * A BACKGROUNDED Task subagent returns its `tool_result` immediately — a launch ack, not the real result —
 * so its anchor block flips `done:true` at launch while the subagent is still streaming. The card must NOT
 * read `done` for a background run; it reads `bgSettled` (stamped on the anchor by the `bg_task` settlement
 * frame). A FOREGROUND subagent's `done` IS its real completion, so it keeps the `!done` behavior.
 */

const anchor = (over: Partial<Extract<LiveBlock, { kind: 'tool' }>>): LiveBlock => ({
  kind: 'tool',
  key: 'a1',
  toolId: 'tu-bg',
  name: 'Task',
  done: false,
  emittedAt: 1,
  ...over,
});

const child = (): LiveBlock => ({
  kind: 'text',
  key: 'c1',
  text: 'working',
  done: false,
  parentToolUseId: 'tu-bg',
  emittedAt: 2,
});

describe('indexLiveSubagents — background subagent running state', () => {
  it('a backgrounded subagent stays running after its launch-ack (done=true) until bg_task settles', () => {
    const blocks: LiveBlock[] = [
      anchor({
        input: { subagent_type: 'general-purpose', run_in_background: true },
        done: true, // the immediate launch ack — NOT completion
      }),
      child(),
    ];
    const summary = indexLiveSubagents(blocks).summaryById.get('tu-bg')!;
    expect(summary.background).toBe(true);
    expect(summary.running).toBe(true); // still working despite done=true (the bug this fixes)
  });

  it('a backgrounded subagent flips to done once bg_task settlement stamps bgSettled on the anchor', () => {
    const blocks: LiveBlock[] = [
      anchor({
        input: { subagent_type: 'general-purpose', run_in_background: true },
        done: true,
        bgSettled: true, // set by the bg_task completed/failed/stopped frame
      }),
      child(),
    ];
    const summary = indexLiveSubagents(blocks).summaryById.get('tu-bg')!;
    expect(summary.running).toBe(false);
  });

  it('a FOREGROUND subagent keeps the unchanged !done behavior (done is its real completion)', () => {
    const running = indexLiveSubagents([
      anchor({
        input: { subagent_type: 'explore', run_in_background: false },
        done: false,
      }),
      child(),
    ]).summaryById.get('tu-bg')!;
    expect(running.background).toBe(false);
    expect(running.running).toBe(true);

    const done = indexLiveSubagents([
      anchor({
        input: { subagent_type: 'explore', run_in_background: false },
        done: true,
      }),
      child(),
    ]).summaryById.get('tu-bg')!;
    // A foreground run's bgSettled is never set; it must NOT keep it running.
    expect(done.running).toBe(false);
  });

  it('a DEFAULTED-background subagent (no run_in_background in input) is recognized via bgStarted', () => {
    // Subagents run in the background BY DEFAULT, so the caller omits `run_in_background` — the input field is
    // absent. The engine's `bg_task 'started'` frame (→ bgStarted) is what tells us it was backgrounded.
    const running = indexLiveSubagents([
      anchor({
        input: { subagent_type: 'test' }, // NOTE: no run_in_background
        done: true, // the launch ack — NOT completion
        bgStarted: true,
      }),
      child(),
    ]).summaryById.get('tu-bg')!;
    expect(running.background).toBe(true); // badge restored despite the missing input field
    expect(running.running).toBe(true); // still working despite done=true (the bug this fixes)

    const settled = indexLiveSubagents([
      anchor({
        input: { subagent_type: 'test' },
        done: true,
        bgStarted: true,
        bgSettled: true, // the bg_task completed/failed/stopped frame
      }),
      child(),
    ]).summaryById.get('tu-bg')!;
    expect(settled.running).toBe(false);
  });
});

/**
 * The DURABLE (reloaded / non-live) subagent card keys running/done off the AUTHORITATIVE `subagentStatus`
 * the backend joins onto the anchor from the `subagents` table — NOT the anchor's `meta.result`, which is the
 * launch-ack for a backgrounded run and would read "done" while the subagent is still working.
 */
const durableAnchor = (
  meta: Record<string, unknown>,
  over: Partial<JobMessage> = {},
): JobMessage => ({
  ts: 'a1',
  threadId: 't1',
  subagentId: null,
  author: 'atlas',
  authorId: 'atlas',
  authorName: 'Atlas',
  text: '',
  kind: 'tool',
  source: 'atlas',
  postedAt: '2026-07-16T00:00:00.000Z',
  meta: {
    id: 'tu-bg',
    name: 'Task',
    input: { subagent_type: 'test' },
    ...meta,
  },
  ...over,
});

const durableChild = (): JobMessage => ({
  ts: 'c1',
  threadId: 't1',
  subagentId: 's1',
  author: 'atlas',
  authorId: 'atlas',
  authorName: 'Atlas',
  text: 'working',
  kind: 'text',
  source: 'atlas',
  postedAt: '2026-07-16T00:00:01.000Z',
  meta: { parentToolUseId: 'tu-bg' },
});

describe('indexDurableSubagents — authoritative status over launch-ack', () => {
  it("subagentStatus 'running' keeps the card running even when meta.result is set (launch ack)", () => {
    const summary = indexDurableSubagents([
      durableAnchor({ result: 'agentId: s1 …' }, { subagentStatus: 'running' }),
      durableChild(),
    ]).summaryById.get('tu-bg')!;
    expect(summary.running).toBe(true);
  });

  it("subagentStatus 'done' marks the card done", () => {
    const summary = indexDurableSubagents([
      durableAnchor({ result: 'agentId: s1 …' }, { subagentStatus: 'done' }),
      durableChild(),
    ]).summaryById.get('tu-bg')!;
    expect(summary.running).toBe(false);
  });

  it('falls back to the meta.result cue when no subagentStatus is present (legacy anchor)', () => {
    const stillRunning = indexDurableSubagents([
      durableAnchor({}), // no result, no subagentStatus
      durableChild(),
    ]).summaryById.get('tu-bg')!;
    expect(stillRunning.running).toBe(true);

    const finished = indexDurableSubagents([
      durableAnchor({ result: 'done' }),
      durableChild(),
    ]).summaryById.get('tu-bg')!;
    expect(finished.running).toBe(false);
  });
});

/**
 * A parent→sub-agent SendMessage injection is captured as a durable `kind: 'user'` transcript row
 * (Thread 1) / a live `kind: 'user'` block (job-stream `user_text` case) and must render as a `UserBubble`
 * interleaved in the sub-agent's own transcript — so both mapping functions must surface it as
 * `SubBlock{ kind: 'user' }` rather than dropping it into the generic `text` fallthrough.
 */
describe("durableSubBlocks — injected 'user' message", () => {
  it("maps a durable kind:'user' message to a SubBlock of kind 'user' (not 'text')", () => {
    const injected: JobMessage = {
      ts: 'c2',
      threadId: 't1',
      subagentId: 's1',
      author: 'atlas',
      authorId: 'atlas',
      authorName: 'Atlas',
      text: 'keep going on the auth module',
      kind: 'user',
      source: 'atlas',
      postedAt: '2026-07-16T00:00:02.000Z',
      meta: { parentToolUseId: 'tu-bg' },
    };
    const [block] = durableSubBlocks([injected]);
    expect(block).toMatchObject({
      kind: 'user',
      text: 'keep going on the auth module',
      postedAt: '2026-07-16T00:00:02.000Z',
    });
  });
});

describe("liveSubBlocksForParent — injected 'user' live block", () => {
  it("passes a live kind:'user' block through as SubBlock{ kind: 'user' }", () => {
    const blocks: LiveBlock[] = [
      {
        kind: 'user',
        key: 'c1',
        text: 'keep going on the auth module',
        done: true,
        parentToolUseId: 'tu-bg',
        emittedAt: 1,
      },
    ];
    const [block] = liveSubBlocksForParent(blocks, 'tu-bg');
    expect(block).toMatchObject({
      kind: 'user',
      key: 'c1',
      text: 'keep going on the auth module',
    });
  });
});
