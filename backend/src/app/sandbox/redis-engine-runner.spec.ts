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
const fakeActivity = { thread: (_id: string, fn: () => unknown) => fn() } as unknown as SandboxActivityRegistry;

function fakeRegistry() {
  return {
    register: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    finalize: vi.fn(async () => undefined),
    getToolReply: vi.fn(async () => null),
    recordToolReply: vi.fn(async () => undefined),
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
      turnMeta: { jobId: 'th1', orgId: 'org1', channel: 'repo1', lane: 'main', kind: 'step' },
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

  it('tool-bridge: dispatches a tool_request over redis and feeds the reply back to the engine', async () => {
    const redis = new InMemoryRedisStream();
    const events: EngineEvent[] = [];
    const toolCalls: Array<{ name: string; args: unknown }> = [];

    // Simulated engine: emit a tool_request on the tools stream, await its reply on the replies stream,
    // then emit a text event + final on the events stream.
    const containers = {
      execDetached: vi.fn(async (_id: string, _argv: string[], opts?: { env?: Record<string, string> }) => {
        const turnId = opts?.env?.TURN_ID;
        if (!turnId) return {};
        const k = turnKeys(turnId);
        void (async () => {
          const callId = 'call-xyz';
          await redis.xadd(k.tools, { t: 'tool_request', id: callId, name: 'submit_plan', args: { foo: 'bar' } });
          let lastId = '0-0';
          for (let i = 0; i < 50; i++) {
            const r = await redis.xread({ stream: k.replies, lastId, count: 10, blockMs: 50 });
            const hit = r.find((e) => (e.data as { id?: string }).id === callId);
            if (hit) {
              const d = hit.data as { t: string };
              await redis.xadd(k.events, { t: 'event', e: { kind: 'text', text: d.t === 'tool_response' ? 'tool-ok' : 'tool-err' } });
              break;
            }
            if (r.length) lastId = r[r.length - 1].id;
          }
          await redis.xadd(k.events, { t: 'final', r: { result: 'DONE' } });
        })();
        return {};
      }),
    } as unknown as ContainerEngine;

    const bridge = {
      jobId: 'th1',
      tools: {
        submit_plan: async (args: Record<string, unknown>) => {
          toolCalls.push({ name: 'submit_plan', args });
          return { ok: true };
        },
      },
    };
    const runner = new RedisEngineRunner(containers, redis, fakeEnv, fakeActivity, fakeRegistry());
    const out = await runner.run({ ...baseArgs((e) => events.push(e)), toolBridge: bridge as never });

    expect(toolCalls).toEqual([{ name: 'submit_plan', args: { foo: 'bar' } }]);
    expect(out).toEqual({ result: 'DONE' });
    expect(events.some((e) => (e as { kind?: string; text?: string }).text === 'tool-ok')).toBe(true);
  });
});
