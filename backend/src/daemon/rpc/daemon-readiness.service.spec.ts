import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The readiness gate (Phase 10): the daemon writes a durable ready marker to `ws:{id}:ready` once the
 * sandbox is up, WAITING for inner Docker first when it's expected (the relaxed-sandbox image posture).
 *
 * `docker info` is mocked at the `node:child_process` seam so no real Docker is needed; the marker XADD
 * is asserted on a fake Redis port. Each case controls WORKSPACE_ID + SANDBOX_GUARD_RELAXED via env.
 */

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

// promisify(execFile) is what the service awaits — make our mock promisify-friendly by giving it the
// (cmd, args, opts, cb) shape util.promisify expects.
// The service awaits `promisify(execFile)`. `promisify` prefers a `[promisify.custom]` impl on the
// target — give the mock one that returns a promise directly, so we control resolve/reject without
// fiddling with callback arity. (The plain mock body still records call count for assertions.)
function dockerInfo(result: 'ok' | 'fail') {
  (execFileMock as unknown as Record<symbol, unknown>)[promisify.custom] = () => {
    execFileMock(); // record the probe for toHaveBeenCalled()
    return result === 'ok'
      ? Promise.resolve({ stdout: '' })
      : Promise.reject(new Error('Cannot connect to the Docker daemon'));
  };
}

async function makeService(
  xadd = vi.fn(async () => '1-0'),
  whenCloned = vi.fn(async () => undefined),
) {
  vi.resetModules();
  const { DaemonReadinessService } = await import('./daemon-readiness.service');
  const redis = { xadd } as never;
  // The readiness gate awaits the boot clone via DaemonGitService.whenCloned (Phase 11) — a stub that
  // resolves immediately models "no clone expected" (or a completed clone).
  const git = { whenCloned } as never;
  return { svc: new DaemonReadinessService(redis, git), xadd, whenCloned };
}

describe('DaemonReadinessService', () => {
  const prevWs = process.env.WORKSPACE_ID;
  const prevRelaxed = process.env.SANDBOX_GUARD_RELAXED;

  beforeEach(() => execFileMock.mockReset());
  afterEach(() => {
    if (prevWs === undefined) delete process.env.WORKSPACE_ID;
    else process.env.WORKSPACE_ID = prevWs;
    if (prevRelaxed === undefined) delete process.env.SANDBOX_GUARD_RELAXED;
    else process.env.SANDBOX_GUARD_RELAXED = prevRelaxed;
  });

  it('does NOT write a marker when WORKSPACE_ID is unset (dev/standalone)', async () => {
    delete process.env.WORKSPACE_ID;
    const { svc, xadd } = await makeService();
    svc.onApplicationBootstrap();
    await new Promise((r) => setTimeout(r, 10));
    expect(xadd).not.toHaveBeenCalled();
  });

  it('writes the marker (innerDocker=false) when inner Docker is NOT expected', async () => {
    process.env.WORKSPACE_ID = 'ws-1';
    delete process.env.SANDBOX_GUARD_RELAXED; // inner docker not expected
    const { svc, xadd } = await makeService();
    svc.onApplicationBootstrap();
    await new Promise((r) => setTimeout(r, 10));
    expect(xadd).toHaveBeenCalledTimes(1);
    const [stream, frame] = xadd.mock.calls[0] as [string, { innerDocker: boolean; ready: boolean }];
    expect(stream).toBe('ws:ws-1:ready');
    expect(frame.ready).toBe(true);
    expect(frame.innerDocker).toBe(false);
    // No docker info probe when inner docker isn't expected.
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('waits for docker info then writes the marker (innerDocker=true) when expected', async () => {
    process.env.WORKSPACE_ID = 'ws-2';
    process.env.SANDBOX_GUARD_RELAXED = 'true'; // inner docker expected
    dockerInfo('ok');
    const { svc, xadd } = await makeService();
    svc.onApplicationBootstrap();
    await new Promise((r) => setTimeout(r, 30));
    expect(execFileMock).toHaveBeenCalled(); // probed docker info
    expect(xadd).toHaveBeenCalledTimes(1);
    const [stream, frame] = xadd.mock.calls[0] as [string, { innerDocker: boolean }];
    expect(stream).toBe('ws:ws-2:ready');
    expect(frame.innerDocker).toBe(true);
  });
});
