import type { EnvService } from '@core/config/env/env.service';
import type { EngineEvent, RunEngineArgs } from '@shared/engine/engine.types';
import { agentMessage } from '@shared/prompt-kit/message';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemoryRedisStream } from '../../../_lib/redis/in-memory-redis-stream';
import type { ContainerEngine } from '../container-engine.port';
import { RedisEngineRunner } from '../redis-engine-runner';
import type { SandboxActivityRegistry } from '../sandbox-activity.registry';
import type { TurnRegistry } from '../turn-registry.service';

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

function realDockerExecContainers(
  redis: InMemoryRedisStream,
  containerId: string,
  seen: { value: string | null },
) {
  return {
    execDetached: vi.fn(
      async (_id: string, _argv: string[], opts?: { env?: Record<string, string> }) => {
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
          seen.value = null;
        }
        const turnId = env.TURN_ID;
        if (turnId) {
          const { turnKeys } = await import('../redis-turn-keys.js');
          const events = turnKeys(turnId).events;
          void redis.xadd(events, { t: 'final', r: { result: 'DONE' } });
        }
        return {};
      },
    ),
  } as unknown as ContainerEngine;
}

function baseArgs(onEvent: (e: EngineEvent) => void, evidenceDir?: string): RunEngineArgs {
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
    containerId = execFileSync('docker', ['run', '-d', '--rm', IMAGE, 'sleep', '180'], {
      encoding: 'utf8',
    }).trim();
  });

  afterAll(() => {
    if (containerId) execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
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

    const out = await runner.run(baseArgs(() => undefined, '/context/evidence/010-backend'));

    expect(out).toMatchObject({ result: 'DONE' });
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
    expect(seen.value).toBeNull();
  });
});
