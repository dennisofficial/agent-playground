import { describe, expect, it, vi } from 'vitest';
import { EngineAuthError } from '../engine';
import type { EngineEvent, RunEngineArgs } from '../engine/engine.types';
import { InMemoryRedisStream } from '../../_lib/redis/in-memory-redis-stream';
import { RedisEngineRunner } from './redis-engine-runner';
import { turnKeys } from './redis-turn-keys';
import type { EnvService } from '@core/config/env/env.service';
import type { SandboxActivityRegistry } from './sandbox-activity.registry';
import type { TurnRegistry } from './turn-registry.service';
import type { ContainerEngine } from './container-engine.port';

const fakeEnv = { get: () => undefined } as unknown as EnvService;
const fakeActivity = { track: (_id: string, fn: () => unknown) => fn() } as unknown as SandboxActivityRegistry;

function fakeRegistry() {
  return {
    register: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    finalize: vi.fn(async () => undefined),
  } as unknown as TurnRegistry & { register: ReturnType<typeof vi.fn>; finalize: ReturnType<typeof vi.fn> };
}

/**
 * A fake ContainerEngine whose `execDetached` plays the in-container engine: it reads TURN_ID from the
 * exec env and asynchronously appends `frames` to that turn's events stream (exactly what the real
 * entrypoint will do over Redis).
 */
function fakeContainers(redis: InMemoryRedisStream, frames: unknown[]) {
  return {
    execDetached: vi.fn(async (_id: string, _argv: string[], opts?: { env?: Record<string, string> }) => {
      const turnId = opts?.env?.TURN_ID;
      if (turnId) {
        const events = turnKeys(turnId).events;
        // Emit on the next tick so the host is already tailing (mirrors a detached process).
        void (async () => {
          for (const f of frames) await redis.xadd(events, f);
        })();
      }
      return {};
    }),
  } as unknown as ContainerEngine;
}

function baseArgs(onEvent: (e: EngineEvent) => void): RunEngineArgs {
  return {
    engine: 'claude',
    task: 'do the thing',
    cwd: '/wt',
    systemPrompt: 'SYS',
    sandboxKey: 'sk',
    mode: 'execute',
    onEvent,
    target: { containerId: 'c1', worktreeHost: '/wt' },
  };
}

describe('RedisEngineRunner (one-shot events transport)', () => {
  it('kicks a detached exec, tails events to onEvent, and returns the final result', async () => {
    const redis = new InMemoryRedisStream();
    const events: EngineEvent[] = [];
    const frames = [
      { t: 'event', e: { kind: 'text', text: 'hello' } },
      { t: 'heartbeat', ts: 1 },
      { t: 'event', e: { kind: 'text', text: 'world' } },
      { t: 'final', r: { result: 'DONE', sessionId: 'sess-1' } },
    ];
    const reg = fakeRegistry();
    const runner = new RedisEngineRunner(
      fakeContainers(redis, frames),
      redis,
      fakeEnv,
      fakeActivity,
      reg,
    );

    const out = await runner.run({
      ...baseArgs((e) => events.push(e)),
      turnMeta: { threadId: 'th1', orgId: 'org1', channel: 'repo1', lane: 'main', kind: 'step' },
    });

    expect(events).toEqual([
      { kind: 'text', text: 'hello' },
      { kind: 'text', text: 'world' },
    ]);
    expect(out).toEqual({ result: 'DONE', sessionId: 'sess-1' });
    expect(reg.register).toHaveBeenCalledOnce(); // turnMeta present → registered
    expect(reg.finalize).toHaveBeenCalledWith(expect.any(String), 'done');
  });

  it('surfaces an engine error frame as a thrown error', async () => {
    const redis = new InMemoryRedisStream();
    const frames = [{ t: 'error', message: 'boom in sandbox' }];
    const runner = new RedisEngineRunner(fakeContainers(redis, frames), redis, fakeEnv, fakeActivity, fakeRegistry());
    await expect(runner.run(baseArgs(() => {}))).rejects.toThrow(/boom in sandbox/);
  });

  it('maps an auth error frame to EngineAuthError', async () => {
    const redis = new InMemoryRedisStream();
    const frames = [{ t: 'error', message: '401 invalid', auth: true, sessionId: 's9' }];
    const runner = new RedisEngineRunner(fakeContainers(redis, frames), redis, fakeEnv, fakeActivity, fakeRegistry());
    await expect(runner.run(baseArgs(() => {}))).rejects.toBeInstanceOf(EngineAuthError);
  });

  it('rejects a tool-bridge turn (Phase 3 not yet implemented) instead of hanging', async () => {
    const redis = new InMemoryRedisStream();
    const runner = new RedisEngineRunner(fakeContainers(redis, []), redis, fakeEnv, fakeActivity, fakeRegistry());
    await expect(
      runner.run({ ...baseArgs(() => {}), toolBridge: { tools: {} } as never }),
    ).rejects.toThrow(/tool-bridge turns over Redis are not yet implemented/);
  });
});
