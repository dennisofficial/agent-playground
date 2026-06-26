import type { EnvService } from '@core/config/env/env.service';
import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../engine';
import type { ContainerEngine, ExecOptions, ExecResult } from './container-engine.port';
import { CONTAINER_AGENT_HOME, DockerEngineRunner } from './docker-engine-runner';
import { SandboxActivityRegistry } from './sandbox-activity.registry';

const env = (values: Record<string, string | undefined> = {}) =>
  ({ get: (k: string) => values[k] }) as unknown as EnvService;

/**
 * A fake ContainerEngine whose `exec` replays scripted NDJSON `chunks` into `onStdout` (chunked however
 * the test wants — to exercise the runner's line buffering), records the call, and returns `exitCode`.
 */
function fakeEngine(chunks: string[], exitCode = 0) {
  const calls: Array<{ id: string; argv: string[]; opts: ExecOptions }> = [];
  const engine: ContainerEngine = {
    ensureNetwork: vi.fn(),
    imageExists: vi.fn(),
    imageId: vi.fn(),
    buildImage: vi.fn(),
    createContainer: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    remove: vi.fn(),
    removeNetwork: vi.fn(),
    removeVolume: vi.fn(),
    list: vi.fn(),
    inspect: vi.fn(),
    listNetworks: vi.fn(),
    listVolumes: vi.fn(),
    async exec(id, argv, opts = {}): Promise<ExecResult> {
      calls.push({ id, argv, opts });
      for (const c of chunks) opts.onStdout?.(c);
      return { exitCode, stdout: chunks.join(''), stderr: '' };
    },
  };
  return { engine, calls };
}

const baseArgs = {
  engine: 'claude' as const,
  task: 'do it',
  cwd: '/host/worktrees/feat', // a HOST path → rewritten onto the worktree's /workspace mount in the sandbox
  systemPrompt: 'persona',
  sandboxKey: 'acme--feat',
  mode: 'execute' as const,
};

describe('DockerEngineRunner', () => {
  it('requires an execution target', async () => {
    const { engine } = fakeEngine([]);
    const runner = new DockerEngineRunner(engine, env(), new SandboxActivityRegistry());
    await expect(runner.run(baseArgs)).rejects.toThrow(/containerId/);
  });

  it('execs the entrypoint, rewrites cwd to /workspace, passes creds as exec env, returns the final frame', async () => {
    const { engine, calls } = fakeEngine([
      JSON.stringify({ t: 'event', e: { kind: 'tool', name: 'Write' } }) + '\n',
      JSON.stringify({ t: 'final', r: { result: 'done', sessionId: 'sess-9' } }) + '\n',
    ]);
    const events: EngineEvent[] = [];
    const runner = new DockerEngineRunner(
      engine,
      env({ CLAUDE_OAUTH_TOKEN: 'oat-123', CODEX_OAUTH_TOKEN: 'codex-123', ANTHROPIC_API_KEY: 'k-123' }),
      new SandboxActivityRegistry(),
    );

    const res = await runner.run({
      ...baseArgs,
      target: { containerId: 'cId', user: '1000:1000', worktreeHost: '/host/worktrees/feat' },
      onEvent: (e) => events.push(e),
    });

    expect(res).toEqual({ result: 'done', sessionId: 'sess-9' });
    expect(events).toEqual([{ kind: 'tool', name: 'Write' }]);

    const call = calls[0]!;
    expect(call.id).toBe('cId');
    expect(call.argv).toEqual(['atlas-engine-turn']);
    expect(call.opts.user).toBe('1000:1000');
    // subscription secrets + in-container home on the exec env — the harness runs subscription-only,
    // so an ambient ANTHROPIC_API_KEY is NEVER forwarded (it would outrank the OAuth token).
    expect(call.opts.env?.CLAUDE_OAUTH_TOKEN).toBe('oat-123');
    expect(call.opts.env?.CODEX_OAUTH_TOKEN).toBe('codex-123');
    expect(call.opts.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call.opts.env?.ENGINE_AUTH_MODE).toBeUndefined();
    expect(call.opts.env?.AGENT_HOME_ROOT).toBe(CONTAINER_AGENT_HOME);
    // spec on stdin with cwd rewritten from the host worktree root onto the /workspace mount
    const spec = JSON.parse(call.opts.stdin!);
    expect(spec.cwd).toBe('/workspace');
    expect(spec.task).toBe('do it');
    expect(spec.sandboxKey).toBe('acme--feat');
    // The durable `/context` shared mount is granted as a writable root (brain authors plan/spec there).
    expect(spec.writableRoots).toContain('/context');
  });

  it('rewrites a host SUBPATH cwd onto /workspace, and falls back to /workspace without worktreeHost', async () => {
    const final = JSON.stringify({ t: 'final', r: { result: 'ok' } }) + '\n';

    // subpath under the worktree root → preserved beneath /workspace
    const sub = fakeEngine([final]);
    await new DockerEngineRunner(sub.engine, env(), new SandboxActivityRegistry()).run({
      ...baseArgs,
      cwd: '/host/worktrees/feat/packages/api',
      target: { containerId: 'c', worktreeHost: '/host/worktrees/feat' },
    });
    expect(JSON.parse(sub.calls[0]!.opts.stdin!).cwd).toBe('/workspace/packages/api');

    // no worktreeHost threaded → fall back to the worktree root
    const fb = fakeEngine([final]);
    await new DockerEngineRunner(fb.engine, env(), new SandboxActivityRegistry()).run({
      ...baseArgs,
      target: { containerId: 'c' },
    });
    expect(JSON.parse(fb.calls[0]!.opts.stdin!).cwd).toBe('/workspace');
  });

  it('buffers NDJSON across arbitrary chunk boundaries', async () => {
    const final = JSON.stringify({ t: 'final', r: { result: 'ok', sessionId: 's' } });
    // split a frame mid-JSON across chunks + no trailing newline on the last
    const { engine } = fakeEngine([`{"t":"even`, `t","e":{"kind":"text","text":"hi"}}\n` + final]);
    const events: EngineEvent[] = [];
    const runner = new DockerEngineRunner(engine, env(), new SandboxActivityRegistry());
    const res = await runner.run({
      ...baseArgs,
      target: { containerId: 'c' },
      onEvent: (e) => events.push(e),
    });
    expect(events).toEqual([{ kind: 'text', text: 'hi' }]);
    expect(res.result).toBe('ok');
  });

  it('throws on an error frame', async () => {
    const { engine } = fakeEngine([JSON.stringify({ t: 'error', message: 'boom' }) + '\n']);
    const runner = new DockerEngineRunner(engine, env(), new SandboxActivityRegistry());
    await expect(runner.run({ ...baseArgs, target: { containerId: 'c' } })).rejects.toThrow(/boom/);
  });

  it('throws when no final frame arrives', async () => {
    const { engine } = fakeEngine([JSON.stringify({ t: 'event', e: { kind: 'text', text: 'x' } }) + '\n'], 3);
    const runner = new DockerEngineRunner(engine, env(), new SandboxActivityRegistry());
    await expect(runner.run({ ...baseArgs, target: { containerId: 'c' } })).rejects.toThrow(/no result/);
  });
});
