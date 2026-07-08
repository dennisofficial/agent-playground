/**
 * Regression test for the Leg-rotation "Stream closed" fix. The SOFT/REMINDER nudge is injected ENGINE-LOCALLY
 * the instant this turn's OWN main-agent occupancy crosses the threshold (mid-stream, input open) — instead of
 * the driver firing it host→Redis and racing the post-`result` input close (`STEER_IDLE_GRACE_MS`). This proves
 * the nudge is delivered deterministically, fires SOFT once on the first crossing, then a REMINDER on each
 * further +delta band, never re-firing a band. There is no hard threshold and no forced rotation.
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
import type { EngineHomeKey } from './engine-home';

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
    sandboxKey: { orgId: 'acme', repoId: 'atlas', jobId: 'feat', type: 'build' } as EngineHomeKey,
    mode: 'execute',
    auth: { secret: 'oauth-tok' },
    steerInput: idleSteerInput,
    rotationNudge: { softTokens: 50_000, reminderDeltaTokens: 20_000, softText: 'SOFT-NUDGE', reminderText: 'REMINDER-NUDGE' },
  } as never);
  return injected;
}

describe('EngineCore — engine-local Leg-rotation nudge (race-free)', () => {
  it('injects SOFT once when occupancy crosses softTokens, mid-stream (never lost to the close)', async () => {
    // Rises 20k → 55k (crosses SOFT=50k) → 60k (still inside the soft band, no re-fire).
    const injected = await runWithOccupancies([20_000, 55_000, 60_000]);
    expect(injected).toEqual(['SOFT-NUDGE']);
  });

  it('injects SOFT then a REMINDER on each further +delta band', async () => {
    // 20k → 55k (SOFT, band 0) → 75k (band 1 → reminder) → 95k (band 2 → reminder) → 110k (still band 2/3? no re-fire same band).
    const injected = await runWithOccupancies([20_000, 55_000, 75_000, 95_000]);
    expect(injected).toEqual(['SOFT-NUDGE', 'REMINDER-NUDGE', 'REMINDER-NUDGE']);
  });

  it('first-ever fire is SOFT even when the first sample is already several bands past soft', async () => {
    // 20k → 95k (band 2, but first → SOFT) → 130k (band 4 → reminder).
    const injected = await runWithOccupancies([20_000, 95_000, 130_000]);
    expect(injected).toEqual(['SOFT-NUDGE', 'REMINDER-NUDGE']);
  });

  it('never nudges while occupancy stays below SOFT', async () => {
    const injected = await runWithOccupancies([10_000, 20_000, 40_000, 49_000]);
    expect(injected).toEqual([]);
  });
});
