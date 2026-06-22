/**
 * R1 — Local-subprocess binding of the tool-bridge transport.
 *
 * Mirrors `DockerEngineRunner` but runs the `engine-entrypoint.mjs` as a **child subprocess** on
 * the host instead of `docker exec`. This gives the same bidirectional stdin/stdout frame protocol
 * (and therefore the same tool-bridge semantics) without needing Docker, so:
 *   - offline/CI gate tests can run with `ATLAS_SANDBOX_MODE=local` and still exercise the full
 *     tool-bridge protocol;
 *   - the host harness process itself runs NO tenant agent code (the SDK session runs in the child).
 *
 * For one-shot (non-bridge) turns this runner is NOT used — those still go through `EngineRunner`
 * (in-process, exactly as before). This runner is instantiated explicitly in tests and, later, by
 * the `AgentSessionManager` when it needs a conversational (bridged) turn in local mode.
 *
 * Nest-free: no `@Injectable`. Callers instantiate directly.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { EngineAuthError } from '../engine/engine.types';
import type { EngineRunResult, EngineRunnerPort, RunEngineArgs } from '../engine/engine.types';
import { ToolBridgeHost, type InboundFrame } from '../engine/tool-bridge-host';

/** Bundled entrypoint path (produced by `pnpm atlas:sandbox:bundle`). */
const ENTRYPOINT_MJS = join(__dirname, 'image', 'engine-entrypoint.mjs');

/**
 * Run the engine-entrypoint.mjs as a subprocess with bidirectional stdio (the tool-bridge path),
 * forwarding env vars that the entrypoint reads for auth/model config.
 */
export class LocalToolBridgeRunner implements EngineRunnerPort {
  /**
   * @param entrypointPath - Override the path to engine-entrypoint.mjs (for tests).
   * @param extraEnv - Extra env vars to inject into the subprocess (e.g. ANTHROPIC_API_KEY).
   */
  constructor(
    private readonly entrypointPath: string = ENTRYPOINT_MJS,
    private readonly extraEnv: Record<string, string> = {},
  ) {}

  async run(args: RunEngineArgs): Promise<EngineRunResult> {
    const spec = {
      engine: args.engine,
      task: args.task,
      cwd: args.cwd,
      systemPrompt: args.systemPrompt,
      sandboxKey: args.sandboxKey,
      mode: args.mode,
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      ...(args.auth ? { auth: args.auth } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.toolBridge ? { toolBridgeTools: Object.keys(args.toolBridge.tools) } : {}),
    };

    const env: Record<string, string> = {
      ...this._engineEnv(),
      ...this.extraEnv,
    };

    const child = spawn(process.execPath, ['--experimental-vm-modules', this.entrypointPath], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let result: EngineRunResult | undefined;
    let errorMsg: string | undefined;
    let errorAuth = false;
    let errorSession: string | undefined;

    if (args.toolBridge) {
      // Bidirectional path: keep stdin open, use ToolBridgeHost to parse frames.
      let stdinWrite!: (data: string) => void;
      let stdinEnd!: () => void;

      stdinWrite = (data) => child.stdin.write(data);
      stdinEnd = () => child.stdin.end();

      const host = new ToolBridgeHost(
        args.toolBridge,
        (line) => stdinWrite(line),
        () => stdinEnd(),
      );

      host.onFrame((frame: InboundFrame) => {
        if (frame.t === 'event') args.onEvent?.(frame.e as import('../engine/engine.types').EngineEvent);
        else if (frame.t === 'final') result = frame.r as EngineRunResult;
        else if (frame.t === 'error') {
          errorMsg = frame.message;
          errorAuth = !!frame.auth;
          errorSession = frame.sessionId;
        }
      });

      // Write initial spec (one JSON line) then keep stdin open for tool_response frames.
      child.stdin.write(`${JSON.stringify(spec)}\n`);

      child.stdout.on('data', (chunk: Buffer) => host.feedChunk(chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => {
        // Diagnostics — emit to host stderr for visibility in tests.
        process.stderr.write(`[entrypoint-local] ${chunk.toString('utf8')}`);
      });

      // Wait for the exec stream to close and the bridge to signal the turn ended.
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          child.on('close', () => resolve());
          child.on('error', reject);
          if (args.signal?.aborted) child.kill();
          else args.signal?.addEventListener('abort', () => child.kill(), { once: true });
        }),
        host.closed,
      ]).catch((err) => {
        // If the host.closed rejects (unexpected), still continue to pick up error frames.
        if (!(err instanceof Error) || !err.message.includes('closed')) throw err;
      });

      host.flush();
    } else {
      // One-shot path: write spec, close stdin, collect stdout.
      child.stdin.write(`${JSON.stringify(spec)}\n`);
      child.stdin.end();

      let buf = '';
      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        type Frame =
          | { t: 'event'; e: import('../engine/engine.types').EngineEvent }
          | { t: 'final'; r: EngineRunResult }
          | { t: 'error'; message: string; auth?: boolean; sessionId?: string };
        let frame: Frame;
        try {
          frame = JSON.parse(trimmed) as Frame;
        } catch {
          return;
        }
        if (frame.t === 'event') args.onEvent?.(frame.e);
        else if (frame.t === 'final') result = frame.r;
        else if (frame.t === 'error') {
          errorMsg = frame.message;
          errorAuth = !!frame.auth;
          errorSession = frame.sessionId;
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        process.stderr.write(`[entrypoint-local] ${chunk.toString('utf8')}`);
      });

      await new Promise<void>((resolve, reject) => {
        child.on('close', () => resolve());
        child.on('error', reject);
        if (args.signal?.aborted) child.kill();
        else args.signal?.addEventListener('abort', () => child.kill(), { once: true });
      });

      if (buf.trim()) handleLine(buf);
    }

    if (errorMsg) {
      if (errorAuth) throw new EngineAuthError(errorMsg, errorSession);
      throw new Error(`local-subprocess engine turn failed: ${errorMsg}`);
    }
    if (!result) {
      throw new Error('local-subprocess engine turn produced no result');
    }
    return result;
  }

  /** Credentials + engine config the child subprocess reads from process.env. */
  private _engineEnv(): Record<string, string> {
    const e: Record<string, string> = {};
    const put = (key: string, value: string | undefined): void => {
      if (value) e[key] = value;
    };
    put('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY);
    put('ATLAS_ENGINE_AUTH_MODE', process.env.ATLAS_ENGINE_AUTH_MODE);
    put('ATLAS_CLAUDE_OAUTH_TOKEN', process.env.ATLAS_CLAUDE_OAUTH_TOKEN);
    put('ATLAS_WORKER_MODEL', process.env.ATLAS_WORKER_MODEL);
    put('WORKER_MODEL', process.env.WORKER_MODEL);
    put('ATLAS_CODEX_MODEL', process.env.ATLAS_CODEX_MODEL);
    put('CODEX_MODEL', process.env.CODEX_MODEL);
    put('ATLAS_AGENT_HOME_ROOT', process.env.ATLAS_AGENT_HOME_ROOT);
    return e;
  }
}
