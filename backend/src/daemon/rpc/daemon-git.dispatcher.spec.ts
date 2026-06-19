/**
 * `DaemonGitDispatcher` allowlist routing — no Redis, no real git service. We hand it a fake
 * `DaemonGitService` (just the methods under test) + a fake `RedisStreamPort` that records the single
 * reply frame, and assert:
 *   - `version` (NEW — drives the host's boot-time version reconciliation) is ON the allowlist and routes
 *     through, with its value written to the per-correlation reply stream;
 *   - an off-allowlist method is REJECTED with an error frame (never a blind `service[method]`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { GitCommand, GitReplyFrame } from '@harness/workspaces/daemon-protocol';
import { replyStream } from '@harness/workspaces/daemon-protocol';
import type { RedisStreamPort } from '../../_lib/redis/redis.port';
import type { DaemonGitService } from '../git/daemon-git.service';
import { DaemonGitDispatcher } from './daemon-git.dispatcher';

function makeRedis(): RedisStreamPort & { frames: Array<{ stream: string; data: unknown }> } {
  const frames: Array<{ stream: string; data: unknown }> = [];
  return {
    frames,
    xadd: vi.fn(async (stream: string, data: unknown) => {
      frames.push({ stream, data });
      return '1-0';
    }),
  } as unknown as RedisStreamPort & {
    frames: Array<{ stream: string; data: unknown }>;
  };
}

function makeGit(over: Partial<DaemonGitService> = {}): DaemonGitService {
  return {
    version: vi.fn(async () => ({ buildVersion: 'sha-current' })),
    ...over,
  } as unknown as DaemonGitService;
}

function gitCmd(method: string, args: unknown[] = []): GitCommand {
  return {
    type: 'git',
    correlationId: 'corr-1',
    payload: { method, args },
  };
}

describe('DaemonGitDispatcher — version() allowlist routing', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('routes the version RPC and writes its value to the reply stream', async () => {
    const git = makeGit();
    const redis = makeRedis();
    const dispatcher = new DaemonGitDispatcher(git, redis);

    await dispatcher.handleGit(gitCmd('version'));

    expect(git.version).toHaveBeenCalledTimes(1);
    expect(redis.frames).toHaveLength(1);
    expect(redis.frames[0].stream).toBe(replyStream('corr-1'));
    const frame = redis.frames[0].data as GitReplyFrame;
    expect(frame).toEqual({ ok: true, value: { buildVersion: 'sha-current' } });
  });

  it('rejects an off-allowlist method with an error frame (never a blind dynamic call)', async () => {
    // A method that EXISTS on the object but is NOT on the RPC allowlist must not be invoked.
    const evil = vi.fn();
    const git = makeGit({ root: evil } as unknown as Partial<DaemonGitService>);
    const redis = makeRedis();
    const dispatcher = new DaemonGitDispatcher(git, redis);

    await dispatcher.handleGit(gitCmd('root'));

    expect(evil).not.toHaveBeenCalled();
    const frame = redis.frames[0].data as GitReplyFrame;
    expect(frame.ok).toBe(false);
    expect((frame as { error: string }).error).toMatch(/unknown git RPC method 'root'/);
  });
});
