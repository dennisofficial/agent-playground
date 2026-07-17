import { describe, expect, it, vi } from 'vitest';
import type {
  ContainerEngine,
  ContainerInfo,
  ExecOptions,
  ExecResult,
} from '../container-engine.port';
import { SandboxManager } from '../sandbox-manager.service';

/**
 * Unit coverage for the EPHEMERAL delivery primitive `SandboxManager.writeToJobContainerPath` — the lane
 * that pipes a one-time value (an OAuth code) straight into a path in the live container over exec STDIN,
 * never persisting it. Asserts: the value rides stdin (never argv/env → can't leak into `docker inspect`),
 * a missing/stopped container fails cleanly, and a hung write (dead FIFO reader) aborts on the timeout.
 */

const JOB_ID = 'job-1234abcd';
const EXPECTED_NAME = `atlas-sbx-thread-${JOB_ID}`;

function fakeInfo(state: string): ContainerInfo {
  return {
    id: 'cid-1',
    name: EXPECTED_NAME,
    state,
    labels: {},
  } as ContainerInfo;
}

/** A minimal ContainerEngine — only `inspect` + `exec` are exercised by the delivery path. */
function makeEngine(over: Partial<ContainerEngine>): ContainerEngine {
  return {
    inspect: async () => fakeInfo('running'),
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    ...over,
  } as unknown as ContainerEngine;
}

function makeManager(engine: ContainerEngine): SandboxManager {
  return new SandboxManager(engine, {} as never, {} as never);
}

describe('SandboxManager.writeToJobContainerPath (ephemeral delivery)', () => {
  it('pipes the value over stdin (never argv/env) into the target path and reports ok', async () => {
    let seenArgv: string[] = [];
    let seenOpts: ExecOptions = {};
    const engine = makeEngine({
      inspect: vi.fn(async (name: string) =>
        name === EXPECTED_NAME ? fakeInfo('running') : null,
      ),
      exec: vi.fn(
        async (
          _id: string,
          argv: string[],
          opts?: ExecOptions,
        ): Promise<ExecResult> => {
          seenArgv = argv;
          seenOpts = opts ?? {};
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      ),
    });
    const mgr = makeManager(engine);

    const res = await mgr.writeToJobContainerPath({
      jobId: JOB_ID,
      path: '/tmp/atlas-login-in',
      value: '4/0AVerificationCode\n',
    });

    expect(res.ok).toBe(true);
    // `cat > "$1"` with the path as the sole positional — value goes to STDIN, not the command line.
    expect(seenArgv).toEqual([
      'sh',
      '-c',
      'cat > "$1"',
      'sh',
      '/tmp/atlas-login-in',
    ]);
    expect(seenOpts.stdin).toBe('4/0AVerificationCode\n');
    expect(seenArgv.join(' ')).not.toContain('4/0AVerificationCode');
    expect(JSON.stringify(seenOpts.env ?? {})).not.toContain(
      '4/0AVerificationCode',
    );
  });

  it('fails cleanly when the container is not running (no exec attempted)', async () => {
    const exec = vi.fn();
    const mgr = makeManager(
      makeEngine({ inspect: async () => fakeInfo('exited'), exec }),
    );

    const res = await mgr.writeToJobContainerPath({
      jobId: JOB_ID,
      path: '/tmp/x',
      value: 'v',
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not running/i);
    expect(exec).not.toHaveBeenCalled();
  });

  it('fails cleanly when there is no container', async () => {
    const mgr = makeManager(makeEngine({ inspect: async () => null }));
    const res = await mgr.writeToJobContainerPath({
      jobId: JOB_ID,
      path: '/tmp/x',
      value: 'v',
    });
    expect(res.ok).toBe(false);
  });

  it('aborts on timeout when the target has no live reader (FIFO write hangs)', async () => {
    // Model a dead FIFO reader: `cat > fifo` blocks forever on open → exec never resolves until aborted.
    const engine = makeEngine({
      exec: async (
        _id: string,
        _argv: string[],
        opts?: ExecOptions,
      ): Promise<ExecResult> => {
        return new Promise<ExecResult>((_resolve, reject) => {
          opts?.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      },
    });
    const mgr = makeManager(engine);

    const res = await mgr.writeToJobContainerPath({
      jobId: JOB_ID,
      path: '/tmp/atlas-login-in',
      value: 'code',
      timeoutMs: 20,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/timed out|not reading/i);
  });

  it('reports a non-zero exit as a failure', async () => {
    const mgr = makeManager(
      makeEngine({
        exec: async () => ({ exitCode: 1, stdout: '', stderr: 'no such file' }),
      }),
    );
    const res = await mgr.writeToJobContainerPath({
      jobId: JOB_ID,
      path: '/nope/x',
      value: 'v',
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/exited 1/);
  });
});

describe('SandboxManager.stopAllServices (per-thread service teardown)', () => {
  it('runs `atlas-svc stop-all` in the running container and reports ok', async () => {
    let seenArgv: string[] = [];
    const engine = makeEngine({
      inspect: vi.fn(async (name: string) =>
        name === EXPECTED_NAME ? fakeInfo('running') : null,
      ),
      exec: vi.fn(async (_id: string, argv: string[]): Promise<ExecResult> => {
        seenArgv = argv;
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    });
    const mgr = makeManager(engine);

    const res = await mgr.stopAllServices(JOB_ID);

    expect(res.ok).toBe(true);
    // Invokes the supervisor by absolute path so it resolves regardless of the exec shell's PATH.
    expect(seenArgv).toEqual(['/usr/local/bin/atlas-svc', 'stop-all']);
  });

  it('fails cleanly when the container is not running (no exec attempted)', async () => {
    const exec = vi.fn();
    const mgr = makeManager(
      makeEngine({ inspect: async () => fakeInfo('exited'), exec }),
    );

    const res = await mgr.stopAllServices(JOB_ID);

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not running/i);
    expect(exec).not.toHaveBeenCalled();
  });

  it('fails cleanly when there is no container', async () => {
    const mgr = makeManager(makeEngine({ inspect: async () => null }));
    const res = await mgr.stopAllServices(JOB_ID);
    expect(res.ok).toBe(false);
  });

  it('reports a non-zero exit as a failure (never throws)', async () => {
    const mgr = makeManager(
      makeEngine({
        exec: async () => ({ exitCode: 3, stdout: '', stderr: 'boom' }),
      }),
    );
    const res = await mgr.stopAllServices(JOB_ID);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/exited 3/);
  });

  it('swallows an exec throw and reports a failure', async () => {
    const mgr = makeManager(
      makeEngine({
        exec: async () => {
          throw new Error('docker daemon gone');
        },
      }),
    );
    const res = await mgr.stopAllServices(JOB_ID);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/docker daemon gone/);
  });
});
