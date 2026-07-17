import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemoryRedisStream } from '../../../_lib/redis/in-memory-redis-stream';
import { agentMessage } from '@shared/prompt-kit/message';
import type { EnvService } from '@core/config/env/env.service';
import type { EngineEvent, RunEngineArgs } from '@shared/engine/engine.types';
import type { ContainerEngine } from '../container-engine.port';
import type { SandboxActivityRegistry } from '../sandbox-activity.registry';
import type { TurnRegistry } from '../turn-registry.service';
import { RedisEngineRunner } from '../redis-engine-runner';

/**
 * LIVE runtime proof for the per-turn `ATLAS_EVIDENCE_DIR` routing: drive the REAL `RedisEngineRunner.run()`
 * (which builds the exec env via the production `execEnv`) against a REAL running Docker container, and read
 * the variable back from INSIDE that container. This exercises the actual production path — `target.evidenceDir`
 * → `execEnv` → the env handed to `execDetached` — and asserts the value is visible to a running process,
 * not just present in an in-memory object. Docker-gated, so it lives in the integration suite.
 */
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
  } as unknown as TurnRegistry;
}

const IMAGE = 'alpine:3.20';

/** A ContainerEngine that runs the exec env inside a REAL container: it reads whatever the production
 *  `execEnv` produced (`opts.env`), applies it to a `docker exec` of `printenv ATLAS_EVIDENCE_DIR`, and
 *  records what the running container actually saw — then plays the in-container engine by appending the
 *  final frame so `run()` resolves. */
function realDockerExecContainers(
  redis: InMemoryRedisStream,
  containerId: string,
  seen: { value: string | null },
) {
  return {
    execDetached: vi.fn(
      async (
        _id: string,
        _argv: string[],
        opts?: { env?: Record<string, string> },
      ) => {
        const env = opts?.env ?? {};
        const dockerArgs = [
          'exec',
          ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
          containerId,
          'printenv',
          'ATLAS_EVIDENCE_DIR',
        ];
        try {
          seen.value = execFileSync('docker', dockerArgs, {
            encoding: 'utf8',
          }).trim();
        } catch {
          // `printenv` exits 1 when the var is unset — that is the "absent" signal.
          seen.value = null;
        }
        const turnId = env.TURN_ID;
        if (turnId) {
          const { turnKeys } = await import('../redis-turn-keys');
          const events = turnKeys(turnId).events;
          void redis.xadd(events, { t: 'final', r: { result: 'DONE' } });
        }
        return {};
      },
    ),
  } as unknown as ContainerEngine;
}

function baseArgs(
  onEvent: (e: EngineEvent) => void,
  evidenceDir?: string,
): RunEngineArgs {
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
    target: {
      containerId: 'c1',
      worktreeHost: '/wt',
      ...(evidenceDir ? { evidenceDir } : {}),
    },
  };
}

describe('RedisEngineRunner — ATLAS_EVIDENCE_DIR reaches a running container', () => {
  let containerId: string;

  beforeAll(() => {
    execFileSync('docker', ['pull', '-q', IMAGE], { stdio: 'ignore' });
    containerId = execFileSync(
      'docker',
      ['run', '-d', '--rm', IMAGE, 'sleep', '180'],
      {
        encoding: 'utf8',
      },
    ).trim();
  });

  afterAll(() => {
    if (containerId)
      execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
  });

  it('emits a thread leg evidenceDir as ATLAS_EVIDENCE_DIR visible inside the container', async () => {
    const redis = new InMemoryRedisStream();
    const seen: { value: string | null } = {
      value: undefined as unknown as string,
    };
    const runner = new RedisEngineRunner(
      realDockerExecContainers(redis, containerId, seen),
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );

    const out = await runner.run(
      baseArgs(() => undefined, '/context/evidence/010-backend'),
    );

    expect(out).toMatchObject({ result: 'DONE' });
    // The value the RUNNING container's `printenv` reported — proves the production env reached it.
    expect(seen.value).toBe('/context/evidence/010-backend');
  });

  it('leaves ATLAS_EVIDENCE_DIR UNSET in the container when the turn has no evidenceDir (brain/no-thread)', async () => {
    const redis = new InMemoryRedisStream();
    const seen: { value: string | null } = { value: 'sentinel' };
    const runner = new RedisEngineRunner(
      realDockerExecContainers(redis, containerId, seen),
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );

    const out = await runner.run(baseArgs(() => undefined));

    expect(out).toMatchObject({ result: 'DONE' });
    // `printenv` exited non-zero inside the container → the var was never injected.
    expect(seen.value).toBeNull();
  });
});
