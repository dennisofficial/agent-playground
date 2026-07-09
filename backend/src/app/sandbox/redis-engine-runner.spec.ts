import { describe, expect, it, vi } from 'vitest';
import { EngineAuthError, EngineDetachedError } from '../engine';
import type { EngineEvent, RunEngineArgs } from '../engine/engine.types';
import { InMemoryRedisStream } from '../../_lib/redis/in-memory-redis-stream';
import {
  RedisEngineRunner,
  TAIL_ALIVE_GRACE_CEILING_MS,
  TAIL_IDLE_TIMEOUT_MS,
} from './redis-engine-runner';
import { turnKeys } from './redis-turn-keys';
import type { EnvService } from '@core/config/env/env.service';
import type { SandboxActivityRegistry } from './sandbox-activity.registry';
import type { TurnRegistry } from './turn-registry.service';
import type { ContainerEngine, ContainerInfo } from './container-engine.port';

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
    sandboxKey: { orgId: 'org-1', repoId: 'repo-1', jobId: 'job-1', type: 'build' },
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

  it('publishes a spec whose writableRoots include the durable /context and /playground mounts', async () => {
    const redis = new InMemoryRedisStream();
    const xadd = vi.spyOn(redis, 'xadd');
    const frames = [{ t: 'final', r: { result: 'DONE', sessionId: 's' } }];
    const runner = new RedisEngineRunner(fakeContainers(redis, frames), redis, fakeEnv, fakeActivity, fakeRegistry());

    await runner.run(baseArgs(() => undefined));

    const specCall = xadd.mock.calls.find(([key]) => String(key).endsWith(':spec'));
    expect(specCall).toBeDefined();
    const spec = specCall![1] as { writableRoots: string[] };
    expect(spec.writableRoots).toContain('/context');
    expect(spec.writableRoots).toContain('/playground');
  });

  describe('auth-refresh write-back', () => {
    const authArgs = (onEvent: (e: EngineEvent) => void): RunEngineArgs => ({
      ...baseArgs(onEvent),
      engine: 'codex',
      auth: { secret: 'the-blob', refreshBack: { orgId: 'org1', engine: 'codex' } },
    });

    it('buildSpec sends only the secret + persistAuthRefresh, STRIPPING refreshBack from the container spec', async () => {
      const redis = new InMemoryRedisStream();
      const xadd = vi.spyOn(redis, 'xadd');
      const frames = [{ t: 'final', r: { result: 'DONE', sessionId: 's' } }];
      const runner = new RedisEngineRunner(fakeContainers(redis, frames), redis, fakeEnv, fakeActivity, fakeRegistry());

      await runner.run(authArgs(() => undefined));

      const spec = xadd.mock.calls.find(([k]) => String(k).endsWith(':spec'))![1] as {
        auth: { secret: string; refreshBack?: unknown };
        persistAuthRefresh?: boolean;
      };
      expect(spec.auth).toEqual({ secret: 'the-blob' }); // refreshBack stripped
      expect(spec.persistAuthRefresh).toBe(true);
    });

    it('omits persistAuthRefresh for env-fallback auth (no refreshBack provenance)', async () => {
      const redis = new InMemoryRedisStream();
      const xadd = vi.spyOn(redis, 'xadd');
      const frames = [{ t: 'final', r: { result: 'DONE', sessionId: 's' } }];
      const runner = new RedisEngineRunner(fakeContainers(redis, frames), redis, fakeEnv, fakeActivity, fakeRegistry());

      await runner.run({ ...baseArgs(() => undefined), engine: 'codex', auth: { secret: 'env-blob' } });

      const spec = xadd.mock.calls.find(([k]) => String(k).endsWith(':spec'))![1] as {
        auth: { secret: string };
        persistAuthRefresh?: boolean;
      };
      expect(spec.auth).toEqual({ secret: 'env-blob' });
      expect(spec.persistAuthRefresh).toBeUndefined();
    });

    it('fires the sink with provenance when the final frame carries a refreshed secret', async () => {
      const redis = new InMemoryRedisStream();
      const frames = [{ t: 'final', r: { result: 'DONE', sessionId: 's', refreshedAuthSecret: 'fresh-blob' } }];
      const sink = { persist: vi.fn(async () => undefined) };
      const runner = new RedisEngineRunner(fakeContainers(redis, frames), redis, fakeEnv, fakeActivity, fakeRegistry(), sink);

      await runner.run(authArgs(() => undefined));

      expect(sink.persist).toHaveBeenCalledWith('org1', 'codex', 'fresh-blob');
    });

    it('does NOT fire the sink when the result has no refreshed secret', async () => {
      const redis = new InMemoryRedisStream();
      const frames = [{ t: 'final', r: { result: 'DONE', sessionId: 's' } }];
      const sink = { persist: vi.fn(async () => undefined) };
      const runner = new RedisEngineRunner(fakeContainers(redis, frames), redis, fakeEnv, fakeActivity, fakeRegistry(), sink);

      await runner.run(authArgs(() => undefined));

      expect(sink.persist).not.toHaveBeenCalled();
    });

    it('does NOT fire the sink without refreshBack provenance (env-fallback run)', async () => {
      const redis = new InMemoryRedisStream();
      const frames = [{ t: 'final', r: { result: 'DONE', sessionId: 's', refreshedAuthSecret: 'fresh-blob' } }];
      const sink = { persist: vi.fn(async () => undefined) };
      const runner = new RedisEngineRunner(fakeContainers(redis, frames), redis, fakeEnv, fakeActivity, fakeRegistry(), sink);

      await runner.run({ ...baseArgs(() => undefined), engine: 'codex', auth: { secret: 'env-blob' } });

      expect(sink.persist).not.toHaveBeenCalled();
    });

    it('a sink throw never fails the turn (best-effort)', async () => {
      const redis = new InMemoryRedisStream();
      const frames = [{ t: 'final', r: { result: 'DONE', sessionId: 's', refreshedAuthSecret: 'fresh-blob' } }];
      const sink = { persist: vi.fn(async () => { throw new Error('store down'); }) };
      const runner = new RedisEngineRunner(fakeContainers(redis, frames), redis, fakeEnv, fakeActivity, fakeRegistry(), sink);

      const out = await runner.run(authArgs(() => undefined));
      expect(out.result).toBe('DONE');
    });
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

  it('a lost Redis transport mid-tail DETACHES: throws EngineDetachedError, leaves the registry row + streams', async () => {
    const redis = new InMemoryRedisStream();
    // The "engine" writes one event, then the host's transport dies (xread starts throwing) while the
    // engine itself is still alive — the watch-respawn shutdown shape.
    const frames = [{ t: 'event', e: { kind: 'text', text: 'hello' } }];
    const reg = fakeRegistry();
    const runner = new RedisEngineRunner(fakeContainers(redis, frames), redis, fakeEnv, fakeActivity, reg);

    const realXread = redis.xread.bind(redis);
    let reads = 0;
    const delSpy = vi.spyOn(redis, 'del');
    vi.spyOn(redis, 'xread').mockImplementation(async (args) => {
      reads += 1;
      if (reads > 2) throw new Error('Connection is closed.'); // both the read and its one retry fail
      return realXread(args);
    });

    await expect(
      runner.run({
        ...baseArgs(() => {}),
        turnMeta: { jobId: 'th1', orgId: 'org1', channel: 'repo1', lane: 'main', kind: 'brain' },
      }),
    ).rejects.toBeInstanceOf(EngineDetachedError);

    // The row + streams are the next boot's re-attach anchor — neither may be touched on a detach.
    expect(reg.finalize).not.toHaveBeenCalled();
    expect(delSpy).not.toHaveBeenCalled();
  });

  it('tracks isAttached for the duration of the attach loop (set mid-turn, cleared after)', async () => {
    const redis = new InMemoryRedisStream();
    const frames = [
      { t: 'event', e: { kind: 'text', text: 'mid' } },
      { t: 'final', r: { result: 'DONE' } },
    ];
    const reg = fakeRegistry();
    const runner = new RedisEngineRunner(fakeContainers(redis, frames), redis, fakeEnv, fakeActivity, reg);

    let turnId = '';
    (reg.register as ReturnType<typeof vi.fn>).mockImplementation(async (input: { turnId: string }) => {
      turnId = input.turnId;
    });
    let attachedMidTurn: boolean | undefined;
    await runner.run({
      ...baseArgs(() => {
        attachedMidTurn ??= runner.isAttached(turnId); // observed while tailing the first event
      }),
      turnMeta: { jobId: 'th1', orgId: 'org1', channel: 'repo1', lane: 'main', kind: 'brain' },
    });

    expect(attachedMidTurn).toBe(true);
    expect(runner.isAttached(turnId)).toBe(false); // cleared once the loop ends
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

  it('injects authenticated git into the exec env when target.gitAuth carries a github token', async () => {
    const redis = new InMemoryRedisStream();
    const frames = [{ t: 'final', r: { result: 'DONE' } }];
    const containers = fakeContainers(redis, frames);
    const runner = new RedisEngineRunner(containers, redis, fakeEnv, fakeActivity, fakeRegistry());

    await runner.run({
      ...baseArgs(() => {}),
      target: {
        containerId: 'c1',
        worktreeHost: '/wt',
        gitAuth: { gitUrl: 'https://github.com/o/r.git', token: 'tok-123' },
      },
    });

    const env = (containers.execDetached as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][2] as { env: Record<string, string> };
    // The token rides the git extraheader (never argv/.git/config), plus the raw token for API/`gh`.
    expect(env.env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    expect(env.env.GIT_CONFIG_VALUE_0).toContain('AUTHORIZATION: basic ');
    expect(env.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.env.GITHUB_TOKEN).toBe('tok-123');
    expect(env.env.GH_TOKEN).toBe('tok-123');
  });

  it('does NOT inject git auth into the exec env when target.gitAuth is absent', async () => {
    const redis = new InMemoryRedisStream();
    const frames = [{ t: 'final', r: { result: 'DONE' } }];
    const containers = fakeContainers(redis, frames);
    const runner = new RedisEngineRunner(containers, redis, fakeEnv, fakeActivity, fakeRegistry());

    await runner.run(baseArgs(() => {})); // baseArgs.target has no gitAuth

    const env = (containers.execDetached as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][2] as { env: Record<string, string> };
    expect(env.env.GITHUB_TOKEN).toBeUndefined();
    expect(env.env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it('steer() XADDs the operator message onto the turn input stream (mid-turn steering)', async () => {
    const redis = new InMemoryRedisStream();
    const runner = new RedisEngineRunner(fakeContainers(redis, []), redis, fakeEnv, fakeActivity, fakeRegistry());

    await runner.steer('T1', 'S1', 'actually, focus on the API layer');

    // The in-container entrypoint reads this durable stream from '0-0'. The stimulus id rides the frame so
    // the engine can emit a correlated `input_ack` after pushing the steer into the session.
    const entries = await redis.xread({ stream: turnKeys('T1').input, lastId: '0-0', count: 10, blockMs: 0 });
    expect(entries).toHaveLength(1);
    expect(entries[0].data).toEqual({ id: 'S1', text: 'actually, focus on the API layer' });
  });

  it('stop() publishes a cooperative abort on the turn abort channel', async () => {
    const redis = new InMemoryRedisStream();
    const runner = new RedisEngineRunner(fakeContainers(redis, []), redis, fakeEnv, fakeActivity, fakeRegistry());
    const publish = vi.spyOn(redis, 'publish');

    await runner.stop('T2');

    expect(publish).toHaveBeenCalledWith(turnKeys('T2').abort, { t: 'abort' });
  });

  describe('idle-tail liveness (a quiet tail is not presumed dead while the container proves itself alive)', () => {
    /** Drive the fake clock + release any parked xread so the tail loop's next Date.now() check runs. */
    async function tick(redis: InMemoryRedisStream, ms: number): Promise<void> {
      await vi.advanceTimersByTimeAsync(ms);
      redis.releaseBlockingReads();
      await vi.advanceTimersByTimeAsync(0);
    }

    it('extends patience past the idle timeout while the container is still running, then succeeds once the engine catches up', async () => {
      vi.useFakeTimers();
      try {
        const redis = new InMemoryRedisStream();
        const inspect = vi.fn(
          async (): Promise<ContainerInfo> => ({ id: 'c1', name: 'c1', state: 'running', labels: {}, startedAt: null }),
        );
        const containers = { execDetached: vi.fn(async () => ({})), inspect } as unknown as ContainerEngine;
        const runner = new RedisEngineRunner(containers, redis, fakeEnv, fakeActivity, fakeRegistry());

        const runPromise = runner.run(baseArgs(() => {}));
        await vi.advanceTimersByTimeAsync(0); // let run() reach the point of calling execDetached

        // Cross the idle timeout with nothing on the stream — the container is still 'running', so this
        // must NOT throw; it should keep waiting.
        await tick(redis, TAIL_IDLE_TIMEOUT_MS + 5_000);
        expect(inspect).toHaveBeenCalled();

        // The "engine" finally catches up and finishes the turn.
        const execCall = (containers.execDetached as unknown as { mock: { calls: [string, string[], { env?: Record<string, string> }][] } })
          .mock.calls[0];
        const turnId = execCall[2]?.env?.TURN_ID;
        expect(turnId).toBeTruthy();
        await redis.xadd(turnKeys(turnId!).events, { t: 'final', r: { result: 'DONE' } });
        redis.releaseBlockingReads();

        await expect(runPromise).resolves.toEqual({ result: 'DONE' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('fails cleanly (never EngineDetachedError) once a still-running container exceeds the alive-grace ceiling', async () => {
      vi.useFakeTimers();
      try {
        const redis = new InMemoryRedisStream();
        const inspect = vi.fn(
          async (): Promise<ContainerInfo> => ({ id: 'c1', name: 'c1', state: 'running', labels: {}, startedAt: null }),
        );
        const containers = { execDetached: vi.fn(async () => ({})), inspect } as unknown as ContainerEngine;
        const runner = new RedisEngineRunner(containers, redis, fakeEnv, fakeActivity, fakeRegistry());

        const rejection = runner.run(baseArgs(() => {})).then(
          () => {
            throw new Error('expected the run to reject');
          },
          (err: unknown) => err,
        );

        // Never emit another frame — the container claims 'running' the whole time, so this must extend
        // patience past the idle timeout, but not forever: it should give up once the ceiling passes.
        const totalMs = TAIL_IDLE_TIMEOUT_MS + TAIL_ALIVE_GRACE_CEILING_MS + 15_000;
        for (let elapsed = 0; elapsed < totalMs; elapsed += 5_000) {
          await tick(redis, 5_000);
        }

        const err = (await rejection) as Error;
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(EngineDetachedError);
        expect(err.message).toMatch(/alive-grace ceiling/);
        expect(inspect).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('still fails immediately at the idle timeout when the container is actually gone (no grace granted)', async () => {
      vi.useFakeTimers();
      try {
        const redis = new InMemoryRedisStream();
        const inspect = vi.fn(
          async (): Promise<ContainerInfo> => ({ id: 'c1', name: 'c1', state: 'exited', labels: {}, startedAt: null }),
        );
        const containers = { execDetached: vi.fn(async () => ({})), inspect } as unknown as ContainerEngine;
        const runner = new RedisEngineRunner(containers, redis, fakeEnv, fakeActivity, fakeRegistry());

        const rejection = runner.run(baseArgs(() => {})).then(
          () => {
            throw new Error('expected the run to reject');
          },
          (err: unknown) => err,
        );

        await tick(redis, TAIL_IDLE_TIMEOUT_MS + 1_000);

        const err = (await rejection) as Error;
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(EngineDetachedError);
        expect(err.message).toMatch(/presumed dead/);
        expect(inspect).toHaveBeenCalledTimes(1); // no grace loop — declared dead on the very first check
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
