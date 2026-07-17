import { describe, expect, it, vi } from 'vitest';
import { EngineAuthError, EngineDetachedError } from '@shared/engine';
import type { EngineEvent, RunEngineArgs } from '@shared/engine/engine.types';
import { InMemoryRedisStream } from '../../../_lib/redis/in-memory-redis-stream';
import {
  RedisEngineRunner,
  TAIL_ALIVE_GRACE_CEILING_MS,
  TAIL_IDLE_TIMEOUT_MS,
} from '../redis-engine-runner';
import { turnKeys } from '../redis-turn-keys';
import type { EnvService } from '@core/config/env/env.service';
import type { SandboxActivityRegistry } from '../sandbox-activity.registry';
import type { TurnRegistry } from '../turn-registry.service';
import type { ContainerEngine, ContainerInfo } from '../container-engine.port';
import { agentMessage } from '@shared/prompt-kit/message';
import type { SandboxProvider } from '../sandbox-provider.port';

const fakeEnv = { get: () => undefined } as unknown as EnvService;
const fakeActivity = {
  thread: (_id: string, fn: () => unknown) => fn(),
} as unknown as SandboxActivityRegistry;

function fakeRegistry() {
  return {
    register: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    finalize: vi.fn(async () => true),
    getToolReply: vi.fn(async () => null),
    recordToolReply: vi.fn(async () => undefined),
  } as unknown as TurnRegistry & {
    register: ReturnType<typeof vi.fn>;
    finalize: ReturnType<typeof vi.fn>;
  };
}

/**
 * A fake ContainerEngine whose `execDetached` plays the in-container engine: it reads TURN_ID from the
 * exec env and asynchronously appends `frames` to that turn's events stream (exactly what the real
 * entrypoint will do over Redis).
 */
function fakeContainers(redis: InMemoryRedisStream, frames: unknown[]) {
  return {
    execDetached: vi.fn(
      async (
        _id: string,
        _argv: string[],
        opts?: { env?: Record<string, string> },
      ) => {
        const turnId = opts?.env?.TURN_ID;
        if (turnId) {
          const events = turnKeys(turnId).events;
          // Emit on the next tick so the host is already tailing (mirrors a detached process).
          void (async () => {
            for (const f of frames) await redis.xadd(events, f);
          })();
        }
        return {};
      },
    ),
  } as unknown as ContainerEngine;
}

function baseArgs(onEvent: (e: EngineEvent) => void): RunEngineArgs {
  return {
    engine: 'claude',
    task: agentMessage('do the thing'),
    cwd: '/wt',
    systemPrompt: agentMessage('SYS'),
    sandboxKey: {
      orgId: 'org-1',
      repoId: 'repo-1',
      jobId: 'job-1',
      type: 'build',
    },
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
      turnMeta: {
        jobId: 'th1',
        orgId: 'org1',
        channel: 'repo1',
        lane: 'main',
        kind: 'step',
      },
    });

    expect(events).toEqual([
      { kind: 'text', text: 'hello' },
      { kind: 'text', text: 'world' },
    ]);
    expect(out).toMatchObject({
      result: 'DONE',
      sessionId: 'sess-1',
      claimed: true,
    });
    expect(out.turnId).toEqual(expect.any(String));
    expect(reg.register).toHaveBeenCalledOnce(); // turnMeta present → registered
    expect(reg.finalize).toHaveBeenCalledWith(expect.any(String), 'done');
  });

  it('stamps rate-limit events with the dispatch credential on a fresh run', async () => {
    const redis = new InMemoryRedisStream();
    const events: EngineEvent[] = [];
    const frames = [
      {
        t: 'event',
        e: {
          kind: 'rate_limit',
          status: 'rejected',
          resetsAt: Date.now(),
          rateLimitType: 'five_hour',
        },
      },
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

    await runner.run({
      ...baseArgs((e) => events.push(e)),
      auth: {
        secret: 'oauth-json',
        kind: 'personal',
        refreshBack: {
          orgId: 'org1',
          engine: 'claude',
          credentialId: 'cred-1',
        },
      },
      turnMeta: {
        jobId: 'th1',
        orgId: 'org1',
        channel: 'repo1',
        lane: 'main',
        kind: 'step',
      },
    });

    expect(events).toEqual([
      expect.objectContaining({ kind: 'rate_limit', credentialId: 'cred-1' }),
    ]);
    expect(reg.register).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ credentialId: 'cred-1' }),
      }),
    );
  });

  it('stamps replayed rate-limit events with the supplied credential on reattach', async () => {
    const redis = new InMemoryRedisStream();
    const turnId = 'turn-reattach';
    await redis.xadd(turnKeys(turnId).events, {
      t: 'event',
      e: {
        kind: 'rate_limit',
        status: 'rejected',
        resetsAt: Date.now(),
        rateLimitType: 'five_hour',
      },
    });
    await redis.xadd(turnKeys(turnId).events, {
      t: 'final',
      r: { result: 'DONE', sessionId: 'sess-1' },
    });
    const events: EngineEvent[] = [];
    const runner = new RedisEngineRunner(
      fakeContainers(redis, []),
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );

    await runner.reattach(turnId, 'c1', {
      onEvent: (e) => events.push(e),
      credentialId: 'cred-reattach',
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'rate_limit',
        credentialId: 'cred-reattach',
      }),
    ]);
  });

  it('publishes a spec whose writableRoots include the durable /context and /playground mounts', async () => {
    const redis = new InMemoryRedisStream();
    const xadd = vi.spyOn(redis, 'xadd');
    const frames = [{ t: 'final', r: { result: 'DONE', sessionId: 's' } }];
    const runner = new RedisEngineRunner(
      fakeContainers(redis, frames),
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );

    await runner.run(baseArgs(() => undefined));

    const specCall = xadd.mock.calls.find(([key]) =>
      String(key).endsWith(':spec'),
    );
    expect(specCall).toBeDefined();
    const spec = specCall![1] as { writableRoots: string[] };
    expect(spec.writableRoots).toContain('/context');
    expect(spec.writableRoots).toContain('/playground');
  });

  describe('auth-refresh write-back', () => {
    const authArgs = (onEvent: (e: EngineEvent) => void): RunEngineArgs => ({
      ...baseArgs(onEvent),
      engine: 'codex',
      auth: {
        secret: 'the-blob',
        refreshBack: { orgId: 'org1', engine: 'codex' },
      },
    });

    it('buildSpec sends only the secret + persistAuthRefresh, STRIPPING refreshBack from the container spec', async () => {
      const redis = new InMemoryRedisStream();
      const xadd = vi.spyOn(redis, 'xadd');
      const frames = [{ t: 'final', r: { result: 'DONE', sessionId: 's' } }];
      const runner = new RedisEngineRunner(
        fakeContainers(redis, frames),
        redis,
        fakeEnv,
        fakeActivity,
        fakeRegistry(),
      );

      await runner.run(authArgs(() => undefined));

      const spec = xadd.mock.calls.find(([k]) =>
        String(k).endsWith(':spec'),
      )![1] as {
        auth: { secret: string; refreshBack?: unknown };
        persistAuthRefresh?: boolean;
      };
      expect(spec.auth).toEqual({ secret: 'the-blob' }); // refreshBack stripped
      expect(spec.persistAuthRefresh).toBe(true);
    });

    it('buildSpec preserves the non-secret Claude personal kind while still stripping refreshBack', async () => {
      const redis = new InMemoryRedisStream();
      const xadd = vi.spyOn(redis, 'xadd');
      const frames = [{ t: 'final', r: { result: 'DONE', sessionId: 's' } }];
      const runner = new RedisEngineRunner(
        fakeContainers(redis, frames),
        redis,
        fakeEnv,
        fakeActivity,
        fakeRegistry(),
      );

      await runner.run({
        ...baseArgs(() => undefined),
        engine: 'claude',
        auth: {
          secret: 'oauth-json',
          kind: 'personal',
          refreshBack: {
            orgId: 'org1',
            engine: 'claude',
            credentialId: 'cred-1',
          },
        },
      });

      const spec = xadd.mock.calls.find(([k]) =>
        String(k).endsWith(':spec'),
      )![1] as {
        auth: { secret: string; kind?: string; refreshBack?: unknown };
        persistAuthRefresh?: boolean;
      };
      expect(spec.auth).toEqual({ secret: 'oauth-json', kind: 'personal' });
      expect(spec.persistAuthRefresh).toBe(true);
    });

    it('omits persistAuthRefresh for env-fallback auth (no refreshBack provenance)', async () => {
      const redis = new InMemoryRedisStream();
      const xadd = vi.spyOn(redis, 'xadd');
      const frames = [{ t: 'final', r: { result: 'DONE', sessionId: 's' } }];
      const runner = new RedisEngineRunner(
        fakeContainers(redis, frames),
        redis,
        fakeEnv,
        fakeActivity,
        fakeRegistry(),
      );

      await runner.run({
        ...baseArgs(() => undefined),
        engine: 'codex',
        auth: { secret: 'env-blob' },
      });

      const spec = xadd.mock.calls.find(([k]) =>
        String(k).endsWith(':spec'),
      )![1] as {
        auth: { secret: string };
        persistAuthRefresh?: boolean;
      };
      expect(spec.auth).toEqual({ secret: 'env-blob' });
      expect(spec.persistAuthRefresh).toBeUndefined();
    });

    it('fires the sink with provenance when the final frame carries a refreshed secret', async () => {
      const redis = new InMemoryRedisStream();
      const frames = [
        {
          t: 'final',
          r: {
            result: 'DONE',
            sessionId: 's',
            refreshedAuthSecret: 'fresh-blob',
          },
        },
      ];
      const sink = { persist: vi.fn(async () => undefined) };
      const runner = new RedisEngineRunner(
        fakeContainers(redis, frames),
        redis,
        fakeEnv,
        fakeActivity,
        fakeRegistry(),
        sink,
      );

      await runner.run(authArgs(() => undefined));

      expect(sink.persist).toHaveBeenCalledWith(
        { orgId: 'org1', engine: 'codex' },
        'fresh-blob',
      );
    });

    it('does NOT fire the sink when the result has no refreshed secret', async () => {
      const redis = new InMemoryRedisStream();
      const frames = [{ t: 'final', r: { result: 'DONE', sessionId: 's' } }];
      const sink = { persist: vi.fn(async () => undefined) };
      const runner = new RedisEngineRunner(
        fakeContainers(redis, frames),
        redis,
        fakeEnv,
        fakeActivity,
        fakeRegistry(),
        sink,
      );

      await runner.run(authArgs(() => undefined));

      expect(sink.persist).not.toHaveBeenCalled();
    });

    it('does NOT fire the sink without refreshBack provenance (env-fallback run)', async () => {
      const redis = new InMemoryRedisStream();
      const frames = [
        {
          t: 'final',
          r: {
            result: 'DONE',
            sessionId: 's',
            refreshedAuthSecret: 'fresh-blob',
          },
        },
      ];
      const sink = { persist: vi.fn(async () => undefined) };
      const runner = new RedisEngineRunner(
        fakeContainers(redis, frames),
        redis,
        fakeEnv,
        fakeActivity,
        fakeRegistry(),
        sink,
      );

      await runner.run({
        ...baseArgs(() => undefined),
        engine: 'codex',
        auth: { secret: 'env-blob' },
      });

      expect(sink.persist).not.toHaveBeenCalled();
    });

    it('a sink throw never fails the turn (best-effort)', async () => {
      const redis = new InMemoryRedisStream();
      const frames = [
        {
          t: 'final',
          r: {
            result: 'DONE',
            sessionId: 's',
            refreshedAuthSecret: 'fresh-blob',
          },
        },
      ];
      const sink = {
        persist: vi.fn(async () => {
          throw new Error('store down');
        }),
      };
      const runner = new RedisEngineRunner(
        fakeContainers(redis, frames),
        redis,
        fakeEnv,
        fakeActivity,
        fakeRegistry(),
        sink,
      );

      const out = await runner.run(authArgs(() => undefined));
      expect(out.result).toBe('DONE');
    });
  });

  it('surfaces an engine error frame as a thrown error', async () => {
    const redis = new InMemoryRedisStream();
    const frames = [{ t: 'error', message: 'boom in sandbox' }];
    const runner = new RedisEngineRunner(
      fakeContainers(redis, frames),
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );
    await expect(runner.run(baseArgs(() => {}))).rejects.toThrow(
      /boom in sandbox/,
    );
  });

  it('does not retain an unreachable claim entry when a fresh run throws', async () => {
    const redis = new InMemoryRedisStream();
    const frames = [{ t: 'error', message: 'boom in sandbox' }];
    const reg = fakeRegistry();
    const runner = new RedisEngineRunner(
      fakeContainers(redis, frames),
      redis,
      fakeEnv,
      fakeActivity,
      reg,
    );
    let turnId = '';
    (reg.register as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: { turnId: string }) => {
        turnId = input.turnId;
      },
    );

    await expect(
      runner.run({
        ...baseArgs(() => {}),
        turnMeta: {
          jobId: 'th1',
          orgId: 'org1',
          channel: 'repo1',
          lane: 'main',
          kind: 'brain',
        },
      }),
    ).rejects.toThrow(/boom in sandbox/);

    expect(turnId).toEqual(expect.any(String));
    expect(runner.consumeClaim(turnId)).toBeUndefined();
  });

  it('maps an auth error frame to EngineAuthError', async () => {
    const redis = new InMemoryRedisStream();
    const frames = [
      { t: 'error', message: '401 invalid', auth: true, sessionId: 's9' },
    ];
    const runner = new RedisEngineRunner(
      fakeContainers(redis, frames),
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );
    await expect(runner.run(baseArgs(() => {}))).rejects.toBeInstanceOf(
      EngineAuthError,
    );
  });

  it('a lost Redis transport mid-tail DETACHES: throws EngineDetachedError, leaves the registry row + streams', async () => {
    const redis = new InMemoryRedisStream();
    // The "engine" writes one event, then the host's transport dies (xreadGroup starts throwing) while
    // the engine itself is still alive — the watch-respawn shutdown shape. The events tail now reads via
    // a consumer group, so the transient failure is injected on `xreadGroup` (not the retired `xread`).
    const frames = [{ t: 'event', e: { kind: 'text', text: 'hello' } }];
    const reg = fakeRegistry();
    const runner = new RedisEngineRunner(
      fakeContainers(redis, frames),
      redis,
      fakeEnv,
      fakeActivity,
      reg,
    );

    const realXreadGroup = redis.xreadGroup.bind(redis);
    let reads = 0;
    const delSpy = vi.spyOn(redis, 'del');
    vi.spyOn(redis, 'xreadGroup').mockImplementation(async (args) => {
      reads += 1;
      if (reads > 2) throw new Error('Connection is closed.'); // both the read and its one retry fail
      return realXreadGroup(args);
    });

    await expect(
      runner.run({
        ...baseArgs(() => {}),
        turnMeta: {
          jobId: 'th1',
          orgId: 'org1',
          channel: 'repo1',
          lane: 'main',
          kind: 'brain',
        },
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
    const runner = new RedisEngineRunner(
      fakeContainers(redis, frames),
      redis,
      fakeEnv,
      fakeActivity,
      reg,
    );

    let turnId = '';
    (reg.register as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: { turnId: string }) => {
        turnId = input.turnId;
      },
    );
    let attachedMidTurn: boolean | undefined;
    await runner.run({
      ...baseArgs(() => {
        attachedMidTurn ??= runner.isAttached(turnId); // observed while tailing the first event
      }),
      turnMeta: {
        jobId: 'th1',
        orgId: 'org1',
        channel: 'repo1',
        lane: 'main',
        kind: 'brain',
      },
    });

    expect(attachedMidTurn).toBe(true);
    expect(runner.isAttached(turnId)).toBe(false); // cleared once the loop ends
  });

  it('tool-bridge: dispatches a tool_request over redis and feeds the reply back to the engine', async () => {
    const redis = new InMemoryRedisStream();
    const events: EngineEvent[] = [];
    const toolCalls: Array<{ name: string; args: unknown }> = [];
    let sawProgress = false;

    // Simulated engine: emit a tool_request on the tools stream, await its reply on the replies stream,
    // then emit a text event + final on the events stream.
    const containers = {
      execDetached: vi.fn(
        async (
          _id: string,
          _argv: string[],
          opts?: { env?: Record<string, string> },
        ) => {
          const turnId = opts?.env?.TURN_ID;
          if (!turnId) return {};
          const k = turnKeys(turnId);
          void (async () => {
            const callId = 'call-xyz';
            await redis.xadd(k.tools, {
              t: 'tool_request',
              id: callId,
              name: 'submit_plan',
              args: { foo: 'bar' },
            });
            let lastId = '0-0';
            let done = false;
            for (let i = 0; i < 50; i++) {
              const r = await redis.xread({
                stream: k.replies,
                lastId,
                count: 10,
                blockMs: 50,
              });
              for (const entry of r) {
                const d = entry.data as { id?: string; t?: string };
                if (d.id !== callId) continue;
                if (d.t === 'tool_progress') {
                  sawProgress = true;
                  continue;
                }
                await redis.xadd(k.events, {
                  t: 'event',
                  e: {
                    kind: 'text',
                    text: d.t === 'tool_response' ? 'tool-ok' : 'tool-err',
                  },
                });
                done = true;
                break;
              }
              if (done) break;
              if (r.length) lastId = r[r.length - 1].id;
            }
            await redis.xadd(k.events, { t: 'final', r: { result: 'DONE' } });
          })();
          return {};
        },
      ),
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
    const runner = new RedisEngineRunner(
      containers,
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );
    const out = await runner.run({
      ...baseArgs((e) => events.push(e)),
      toolBridge: bridge as never,
    });

    expect(toolCalls).toEqual([{ name: 'submit_plan', args: { foo: 'bar' } }]);
    expect(sawProgress).toBe(true);
    expect(out).toMatchObject({ result: 'DONE', claimed: true });
    expect(out.turnId).toEqual(expect.any(String));
    expect(
      events.some(
        (e) => (e as { kind?: string; text?: string }).text === 'tool-ok',
      ),
    ).toBe(true);
  });

  it('filters __-prefixed tool names out of the model-facing toolBridgeTools projection', async () => {
    const redis = new InMemoryRedisStream();
    let capturedSpec: Record<string, unknown> | undefined;
    const containers = {
      execDetached: vi.fn(
        async (
          _id: string,
          _argv: string[],
          opts?: { env?: Record<string, string> },
        ) => {
          const turnId = opts?.env?.TURN_ID;
          if (turnId) {
            const k = turnKeys(turnId);
            const specFrames = await redis.xread({
              stream: k.spec,
              lastId: '0-0',
              count: 10,
              blockMs: 50,
            });
            capturedSpec = specFrames[0]?.data as
              | Record<string, unknown>
              | undefined;
            void redis.xadd(k.events, { t: 'final', r: { result: 'DONE' } });
          }
          return {};
        },
      ),
    } as unknown as ContainerEngine;
    const bridge = {
      jobId: 'th1',
      tools: {
        submit_plan: async () => ({ ok: true }),
        __profile_awareness: async () => null,
      },
    };
    const runner = new RedisEngineRunner(
      containers,
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );
    await runner.run({
      ...baseArgs(() => undefined),
      toolBridge: bridge as never,
    });
    expect(capturedSpec?.toolBridgeTools).toEqual(['submit_plan']);
  });

  it('injects authenticated git into the exec env when target.gitAuth carries a github token', async () => {
    const redis = new InMemoryRedisStream();
    const frames = [{ t: 'final', r: { result: 'DONE' } }];
    const containers = fakeContainers(redis, frames);
    const runner = new RedisEngineRunner(
      containers,
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );

    await runner.run({
      ...baseArgs(() => {}),
      target: {
        containerId: 'c1',
        worktreeHost: '/wt',
        gitAuth: { gitUrl: 'https://github.com/o/r.git', token: 'tok-123' },
      },
    });

    const env = (
      containers.execDetached as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0][2] as { env: Record<string, string> };
    // The token rides the git extraheader (never argv/.git/config), plus the raw token for API/`gh`.
    expect(env.env.GIT_CONFIG_KEY_0).toBe(
      'http.https://github.com/.extraheader',
    );
    expect(env.env.GIT_CONFIG_VALUE_0).toContain('AUTHORIZATION: basic ');
    expect(env.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.env.GITHUB_TOKEN).toBe('tok-123');
    expect(env.env.GH_TOKEN).toBe('tok-123');
    // No identity was supplied — the author/committer env vars are absent.
    expect(env.env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(env.env.GIT_AUTHOR_EMAIL).toBeUndefined();
    expect(env.env.GIT_COMMITTER_NAME).toBeUndefined();
    expect(env.env.GIT_COMMITTER_EMAIL).toBeUndefined();
  });

  it('injects the app-mode file-backed git helper and seeds the token file', async () => {
    const redis = new InMemoryRedisStream();
    const frames = [{ t: 'final', r: { result: 'DONE' } }];
    const containers = fakeContainers(redis, frames);
    const writeGithubTokenFile = vi.fn(async () => undefined);
    const runner = new RedisEngineRunner(
      containers,
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
      undefined,
      undefined,
      { writeGithubTokenFile } as unknown as SandboxProvider,
    );

    await runner.run({
      ...baseArgs(() => {}),
      turnMeta: {
        jobId: 'job-1',
        orgId: 'org-1',
        channel: 'repo-1',
        lane: 'main',
        kind: 'step',
      },
      target: {
        containerId: 'c1',
        worktreeHost: '/wt',
        gitAuth: {
          gitUrl: 'https://github.com/o/r.git',
          token: 'ghs_123',
          mode: 'app',
        },
      },
    });

    expect(writeGithubTokenFile).toHaveBeenCalledWith('job-1', 'ghs_123');
    const env = (
      containers.execDetached as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0][2] as { env: Record<string, string> };
    expect(env.env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.env.GIT_CONFIG_KEY_1).toBe(
      'credential.https://github.com.helper',
    );
    expect(env.env.GIT_CONFIG_VALUE_1).toContain("cat '/.atlas/github-token'");
    expect(env.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.env.GITHUB_TOKEN).toBe('ghs_123');
    expect(env.env.GH_TOKEN).toBe('ghs_123');
  });

  it('uses apiToken for gh while app-mode git stays on the file-backed transport token', async () => {
    const redis = new InMemoryRedisStream();
    const frames = [{ t: 'final', r: { result: 'DONE' } }];
    const containers = fakeContainers(redis, frames);
    const writeGithubTokenFile = vi.fn(async () => undefined);
    const runner = new RedisEngineRunner(
      containers,
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
      undefined,
      undefined,
      { writeGithubTokenFile } as unknown as SandboxProvider,
    );

    await runner.run({
      ...baseArgs(() => {}),
      turnMeta: {
        jobId: 'job-1',
        orgId: 'org-1',
        channel: 'repo-1',
        lane: 'main',
        kind: 'step',
      },
      target: {
        containerId: 'c1',
        worktreeHost: '/wt',
        gitAuth: {
          gitUrl: 'https://github.com/o/r.git',
          token: 'ghs_transport',
          apiToken: 'ghp_identity',
          mode: 'app',
        },
      },
    });

    expect(writeGithubTokenFile).toHaveBeenCalledWith('job-1', 'ghs_transport');
    const env = (
      containers.execDetached as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0][2] as { env: Record<string, string> };
    expect(env.env.GIT_CONFIG_KEY_1).toBe(
      'credential.https://github.com.helper',
    );
    expect(env.env.GIT_CONFIG_VALUE_1).toContain("cat '/.atlas/github-token'");
    expect(env.env.GITHUB_TOKEN).toBe('ghp_identity');
    expect(env.env.GH_TOKEN).toBe('ghp_identity');
  });

  it('blanks credential helpers when a GitHub target has no token', async () => {
    const redis = new InMemoryRedisStream();
    const frames = [{ t: 'final', r: { result: 'DONE' } }];
    const containers = fakeContainers(redis, frames);
    const runner = new RedisEngineRunner(
      containers,
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );

    await runner.run({
      ...baseArgs(() => {}),
      target: {
        containerId: 'c1',
        worktreeHost: '/wt',
        gitAuth: { gitUrl: 'https://github.com/o/r.git' },
      },
    });

    const env = (
      containers.execDetached as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0][2] as { env: Record<string, string> };
    expect(env.env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.env.GITHUB_TOKEN).toBeUndefined();
    expect(env.env.GH_TOKEN).toBeUndefined();
  });

  it('injects author/committer env vars when target.gitAuth carries an identity', async () => {
    const redis = new InMemoryRedisStream();
    const frames = [{ t: 'final', r: { result: 'DONE' } }];
    const containers = fakeContainers(redis, frames);
    const runner = new RedisEngineRunner(
      containers,
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );

    await runner.run({
      ...baseArgs(() => {}),
      target: {
        containerId: 'c1',
        worktreeHost: '/wt',
        gitAuth: {
          gitUrl: 'https://github.com/o/r.git',
          token: 'tok-123',
          identity: {
            name: 'The Octocat',
            email: '583231+octocat@users.noreply.github.com',
          },
        },
      },
    });

    const env = (
      containers.execDetached as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0][2] as { env: Record<string, string> };
    expect(env.env.GIT_AUTHOR_NAME).toBe('The Octocat');
    expect(env.env.GIT_AUTHOR_EMAIL).toBe(
      '583231+octocat@users.noreply.github.com',
    );
    expect(env.env.GIT_COMMITTER_NAME).toBe('The Octocat');
    expect(env.env.GIT_COMMITTER_EMAIL).toBe(
      '583231+octocat@users.noreply.github.com',
    );
  });

  it('does NOT inject git auth into the exec env when target.gitAuth is absent', async () => {
    const redis = new InMemoryRedisStream();
    const frames = [{ t: 'final', r: { result: 'DONE' } }];
    const containers = fakeContainers(redis, frames);
    const runner = new RedisEngineRunner(
      containers,
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );

    await runner.run(baseArgs(() => {})); // baseArgs.target has no gitAuth

    const env = (
      containers.execDetached as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0][2] as { env: Record<string, string> };
    expect(env.env.GITHUB_TOKEN).toBeUndefined();
    expect(env.env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it('emits ATLAS_EVIDENCE_DIR in the exec env when target.evidenceDir is set', async () => {
    const redis = new InMemoryRedisStream();
    const frames = [{ t: 'final', r: { result: 'DONE' } }];
    const containers = fakeContainers(redis, frames);
    const runner = new RedisEngineRunner(
      containers,
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );

    await runner.run({
      ...baseArgs(() => {}),
      target: {
        containerId: 'c1',
        worktreeHost: '/wt',
        evidenceDir: '/context/evidence/010-backend',
      },
    });

    const env = (
      containers.execDetached as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0][2] as { env: Record<string, string> };
    expect(env.env.ATLAS_EVIDENCE_DIR).toBe('/context/evidence/010-backend');
  });

  it('does NOT emit ATLAS_EVIDENCE_DIR when target.evidenceDir is absent', async () => {
    const redis = new InMemoryRedisStream();
    const frames = [{ t: 'final', r: { result: 'DONE' } }];
    const containers = fakeContainers(redis, frames);
    const runner = new RedisEngineRunner(
      containers,
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );

    await runner.run(baseArgs(() => {})); // baseArgs.target has no evidenceDir

    const env = (
      containers.execDetached as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0][2] as { env: Record<string, string> };
    expect(env.env.ATLAS_EVIDENCE_DIR).toBeUndefined();
  });

  it('steer() XADDs the operator message onto the turn input stream (mid-turn steering)', async () => {
    const redis = new InMemoryRedisStream();
    const runner = new RedisEngineRunner(
      fakeContainers(redis, []),
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );

    await runner.steer('T1', 'S1', 'actually, focus on the API layer');

    // The in-container entrypoint reads this durable stream from '0-0'. The stimulus id rides the frame so
    // the engine can emit a correlated `input_ack` after pushing the steer into the session.
    const entries = await redis.xread({
      stream: turnKeys('T1').input,
      lastId: '0-0',
      count: 10,
      blockMs: 0,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].data).toEqual({
      id: 'S1',
      text: 'actually, focus on the API layer',
    });
  });

  it('stop() publishes a cooperative abort on the turn abort channel', async () => {
    const redis = new InMemoryRedisStream();
    const runner = new RedisEngineRunner(
      fakeContainers(redis, []),
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );
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
          async (): Promise<ContainerInfo> => ({
            id: 'c1',
            name: 'c1',
            state: 'running',
            labels: {},
            startedAt: null,
          }),
        );
        const containers = {
          execDetached: vi.fn(async () => ({})),
          inspect,
        } as unknown as ContainerEngine;
        const runner = new RedisEngineRunner(
          containers,
          redis,
          fakeEnv,
          fakeActivity,
          fakeRegistry(),
        );

        const runPromise = runner.run(baseArgs(() => {}));
        await vi.advanceTimersByTimeAsync(0); // let run() reach the point of calling execDetached

        // Cross the idle timeout with nothing on the stream — the container is still 'running', so this
        // must NOT throw; it should keep waiting.
        await tick(redis, TAIL_IDLE_TIMEOUT_MS + 5_000);
        expect(inspect).toHaveBeenCalled();

        // The "engine" finally catches up and finishes the turn.
        const execCall = (
          containers.execDetached as unknown as {
            mock: {
              calls: [string, string[], { env?: Record<string, string> }][];
            };
          }
        ).mock.calls[0];
        const turnId = execCall[2]?.env?.TURN_ID;
        expect(turnId).toBeTruthy();
        await redis.xadd(turnKeys(turnId!).events, {
          t: 'final',
          r: { result: 'DONE' },
        });
        redis.releaseBlockingReads();

        await expect(runPromise).resolves.toMatchObject({
          result: 'DONE',
          claimed: true,
          turnId,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('fails cleanly (never EngineDetachedError) once a still-running container exceeds the alive-grace ceiling', async () => {
      vi.useFakeTimers();
      try {
        const redis = new InMemoryRedisStream();
        const inspect = vi.fn(
          async (): Promise<ContainerInfo> => ({
            id: 'c1',
            name: 'c1',
            state: 'running',
            labels: {},
            startedAt: null,
          }),
        );
        const containers = {
          execDetached: vi.fn(async () => ({})),
          inspect,
        } as unknown as ContainerEngine;
        const runner = new RedisEngineRunner(
          containers,
          redis,
          fakeEnv,
          fakeActivity,
          fakeRegistry(),
        );

        const rejection = runner.run(baseArgs(() => {})).then(
          () => {
            throw new Error('expected the run to reject');
          },
          (err: unknown) => err,
        );

        // Never emit another frame — the container claims 'running' the whole time, so this must extend
        // patience past the idle timeout, but not forever: it should give up once the ceiling passes.
        const totalMs =
          TAIL_IDLE_TIMEOUT_MS + TAIL_ALIVE_GRACE_CEILING_MS + 15_000;
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
          async (): Promise<ContainerInfo> => ({
            id: 'c1',
            name: 'c1',
            state: 'exited',
            labels: {},
            startedAt: null,
          }),
        );
        const containers = {
          execDetached: vi.fn(async () => ({})),
          inspect,
        } as unknown as ContainerEngine;
        const runner = new RedisEngineRunner(
          containers,
          redis,
          fakeEnv,
          fakeActivity,
          fakeRegistry(),
        );

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
