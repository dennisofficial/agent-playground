import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { legRotationRule } from '../prompt-kit/jit';
import { EngineCore } from './engine-core';
import type { EngineHomeKey } from './engine-home';

const HOME_ROOT = join(tmpdir(), `atlas-rotation-nudge-${process.pid}`);
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));
const ORIG_ENABLED = legRotationRule.enabled;
afterEach(() => {
  legRotationRule.enabled = ORIG_ENABLED;
});

const idleSteerInput: AsyncIterable<{ id?: string; text: string }> = {
  [Symbol.asyncIterator]() {
    return {
      next: () => new Promise<IteratorResult<{ id?: string; text: string }>>(() => {}),
    };
  },
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

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
            if (!taskSeen) {
              taskSeen = true;
              continue;
            } // the initial task push
            const content = (r.value as { message?: { content?: unknown } }).message?.content;
            injected.push(typeof content === 'string' ? content : JSON.stringify(content));
          }
        })();
        for (const occ of occupancies) {
          yield {
            type: 'assistant',
            message: {
              model: 'opus',
              content: [{ type: 'text', text: 'work' }],
              usage: { input_tokens: occ },
            },
          };
          await tick(); // let the engine inject (synchronously) and the drain loop consume before the next round-trip
        }
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          result: 'ok',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        await tick();
      })(),
  } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');
}

async function runWithOccupancies(occupancies: number[]): Promise<string[]> {
  const injected: string[] = [];
  const core = new EngineCore(nudgeCapturingSdk(occupancies, injected), {} as never, {
    homeRoot: HOME_ROOT,
  });
  await core.run({
    engine: 'claude',
    task: 'do a tiny thing',
    cwd: '/tmp/wt',
    systemPrompt: 'persona',
    sandboxKey: {
      orgId: 'acme',
      repoId: 'atlas',
      jobId: 'feat',
      type: 'build',
    } as EngineHomeKey,
    mode: 'execute',
    auth: { secret: 'oauth-tok' },
    steerInput: idleSteerInput,
    rotationNudge: {
      softTokens: 50_000,
      reminderDeltaTokens: 20_000,
      softText: 'SOFT-NUDGE',
      reminderText: 'REMINDER-NUDGE',
    },
  } as never);
  return injected;
}

describe('EngineCore — engine-local Leg-rotation nudge (race-free)', () => {
  it('injects SOFT once when occupancy crosses softTokens, mid-stream (never lost to the close)', async () => {
    const injected = await runWithOccupancies([20_000, 55_000, 60_000]);
    expect(injected).toEqual(['SOFT-NUDGE']);
  });

  it('injects SOFT then a REMINDER on each further +delta band', async () => {
    const injected = await runWithOccupancies([20_000, 55_000, 75_000, 95_000]);
    expect(injected).toEqual(['SOFT-NUDGE', 'REMINDER-NUDGE', 'REMINDER-NUDGE']);
  });

  it('first-ever fire is SOFT even when the first sample is already several bands past soft', async () => {
    const injected = await runWithOccupancies([20_000, 95_000, 130_000]);
    expect(injected).toEqual(['SOFT-NUDGE', 'REMINDER-NUDGE']);
  });

  it('never nudges while occupancy stays below SOFT', async () => {
    const injected = await runWithOccupancies([10_000, 20_000, 40_000, 49_000]);
    expect(injected).toEqual([]);
  });

  it('honors leg-rotation.enabled=false by suppressing engine-local nudges', async () => {
    legRotationRule.enabled = false;
    const injected = await runWithOccupancies([20_000, 55_000, 75_000, 95_000]);
    expect(injected).toEqual([]);
  });
});
