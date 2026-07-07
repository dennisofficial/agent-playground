/**
 * Regression test for the Leg-rotation "Stream closed" fix. The SOFT/HARD nudge is now injected ENGINE-LOCALLY
 * the instant this turn's OWN main-agent occupancy crosses the threshold (mid-stream, input open) — instead of
 * the driver firing it host→Redis and racing the post-`result` input close (`STEER_IDLE_GRACE_MS`). This proves
 * the nudge is delivered deterministically, latches SOFT-then-HARD once each, and HARD supersedes SOFT.
 *
 * A spike (deleted) first showed the old bug: a steer arriving after the 350ms grace hit an already-closed
 * input stream and was lost — which is why the handoff never happened AND, with a live background task, why
 * `canUseTool` failed "Stream closed". Injecting locally removes the race entirely.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { EngineCore } from './engine-core';

const HOME_ROOT = join(tmpdir(), `atlas-rotation-nudge-${process.pid}`);
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

/** A steerInput that never yields — it just flips the engine into streaming-input mode so `input` exists. */
const idleSteerInput: AsyncIterable<{ id?: string; text: string }> = {
  [Symbol.asyncIterator]() {
    return { next: () => new Promise<IteratorResult<{ id?: string; text: string }>>(() => {}) };
  },
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/**
 * Fake SDK that emits main-agent `assistant` messages with a scripted per-call occupancy. A SINGLE background
 * loop drains its own input stream — consuming the initial task, then recording every subsequent message (each
 * an engine-injected rotation nudge) into `injected`. One consumer means no dangling reads that could swallow a
 * push. A short `tick` between assistants lets the engine process + inject and the drain consume, in order.
 */
function nudgeCapturingSdk(occupancies: number[], injected: string[]) {
  return {
    query: ({ prompt }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
        const it = prompt[Symbol.asyncIterator]();
        let taskSeen = false;
        void (async () => {
          while (true) {
            const r = await it.next();
            if (r.done) break;
            if (!taskSeen) { taskSeen = true; continue; } // the initial task push
            const content = (r.value as { message?: { content?: unknown } }).message?.content;
            injected.push(typeof content === 'string' ? content : JSON.stringify(content));
          }
        })();
        for (const occ of occupancies) {
          // One main-agent round-trip whose per-call input size is `occ` (parent_tool_use_id UNSET = main agent).
          yield { type: 'assistant', message: { model: 'opus', content: [{ type: 'text', text: 'work' }], usage: { input_tokens: occ } } };
          await tick(); // let the engine inject (synchronously) and the drain loop consume before the next round-trip
        }
        yield { type: 'result', subtype: 'success', session_id: 'sess-1', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
        await tick();
      })(),
  } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');
}

async function runWithOccupancies(occupancies: number[]): Promise<string[]> {
  const injected: string[] = [];
  const core = new EngineCore(nudgeCapturingSdk(occupancies, injected), {} as never, { homeRoot: HOME_ROOT });
  await core.run({
    engine: 'claude',
    task: 'do a tiny thing',
    cwd: '/tmp/wt',
    systemPrompt: 'persona',
    sandboxKey: 'acme--feat',
    mode: 'execute',
    auth: { secret: 'oauth-tok' },
    steerInput: idleSteerInput,
    rotationNudge: { softTokens: 50_000, hardTokens: 70_000, softText: 'SOFT-NUDGE', hardText: 'HARD-NUDGE' },
  } as never);
  return injected;
}

describe('EngineCore — engine-local Leg-rotation nudge (race-free)', () => {
  it('injects SOFT once when occupancy crosses softTokens, mid-stream (never lost to the close)', async () => {
    // Rises 20k → 55k (crosses SOFT=50k) → 60k (still < HARD, no re-fire).
    const injected = await runWithOccupancies([20_000, 55_000, 60_000]);
    expect(injected).toEqual(['SOFT-NUDGE']);
  });

  it('injects SOFT then HARD, each once, as occupancy climbs past both thresholds', async () => {
    // 20k → 55k (SOFT) → 75k (HARD) → 90k (no re-fire).
    const injected = await runWithOccupancies([20_000, 55_000, 75_000, 90_000]);
    expect(injected).toEqual(['SOFT-NUDGE', 'HARD-NUDGE']);
  });

  it('a turn that jumps straight past HARD fires HARD only (SOFT is skipped, not replayed)', async () => {
    // 20k → 90k (crosses HARD directly) → 95k (no re-fire).
    const injected = await runWithOccupancies([20_000, 90_000, 95_000]);
    expect(injected).toEqual(['HARD-NUDGE']);
  });

  it('never nudges while occupancy stays below SOFT', async () => {
    const injected = await runWithOccupancies([10_000, 20_000, 40_000, 49_000]);
    expect(injected).toEqual([]);
  });
});
