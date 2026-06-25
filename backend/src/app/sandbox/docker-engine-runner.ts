import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EngineAuthError,
  type EngineEvent,
  type EngineRunResult,
  type EngineRunnerPort,
  type RunEngineArgs,
} from '../engine';
import { ToolBridgeHost, type InboundFrame } from '../engine/tool-bridge-host';
import { CONTAINER_ENGINE, type ContainerEngine } from './container-engine.port';
import { SandboxActivityRegistry } from './sandbox-activity.registry';

/** The engine's isolated agent home INSIDE the sandbox (long-lived → session resume across turns). */
export const CONTAINER_AGENT_HOME = '/atlas-home';

/**
 * One NDJSON frame the in-container entrypoint emits (one-shot mode).
 * In bidirectional (tool-bridge) mode the additional `tool_request` frame is handled by
 * `ToolBridgeHost`; these are the remaining frame types.
 */
type Frame =
  | { t: 'event'; e: EngineEvent }
  | { t: 'final'; r: EngineRunResult }
  | { t: 'error'; message: string; auth?: boolean; sessionId?: string };

/**
 * The `docker` binding of `ENGINE_RUNNER` — runs a turn INSIDE a sandbox container via one-shot
 * `docker exec` of the baked-in `atlas-engine-turn` entrypoint. It serializes the turn spec to the
 * exec's stdin, passes credentials as exec ENV (never on the container/image), streams the entrypoint's
 * NDJSON stdout back into `onEvent`, and returns the final `EngineRunResult`. The same {@link
 * EngineCore} runs on both sides, so behavior matches the in-process runner exactly.
 *
 * Requires `args.target.containerId` (the sandbox to exec into) — the explicit execution target the
 * driver/auto-fix/gate thread through. The worktree (and its git common dir) are bind-mounted into the
 * sandbox at their SAME absolute host paths, so `cwd` passes through unchanged and in-container git
 * resolves correctly for linked worktrees.
 */
@Injectable()
export class DockerEngineRunner implements EngineRunnerPort {
  private readonly logger = new Logger(DockerEngineRunner.name);

  constructor(
    @Inject(CONTAINER_ENGINE) private readonly containers: ContainerEngine,
    private readonly env: EnvService,
    private readonly activity: SandboxActivityRegistry,
  ) {}

  async run(args: RunEngineArgs): Promise<EngineRunResult> {
    const target = args.target;
    if (!target?.containerId) {
      throw new Error('DockerEngineRunner requires args.target.containerId (docker sandbox mode)');
    }

    // The serializable turn spec — `cwd` passes through (the worktree is mounted at its same host path).
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
      // Rich token-level streaming (deltas + thinking + tool_use/tool_result) — the thread brain sets it;
      // it MUST be forwarded across the container boundary or the in-container engine stays coarse.
      ...(args.richStream ? { richStream: args.richStream } : {}),
      // Signal to the entrypoint that the tool bridge is active (tool names list).
      ...(args.toolBridge ? { toolBridgeTools: Object.keys(args.toolBridge.tools) } : {}),
    };

    // Mark the container busy for the duration of the exec so the idle reaper never tears it down
    // mid-turn (which would kill a live build/plan/auto-fix turn).
    return this.activity.track(target.containerId, () =>
      args.toolBridge
        ? this._runBidirectional(args, target, spec)
        : this._runOneShot(args, target, spec),
    );
  }

  /** One-shot (existing build-turn) path: write spec to stdin, close, consume stdout NDJSON. */
  private async _runOneShot(
    args: RunEngineArgs,
    target: NonNullable<RunEngineArgs['target']>,
    spec: object,
  ): Promise<EngineRunResult> {
    let result: EngineRunResult | undefined;
    let errorMsg: string | undefined;
    let errorAuth = false;
    let errorSession: string | undefined;
    let buf = '';
    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
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

    const exec = await this.containers.exec(target.containerId, ['atlas-engine-turn'], {
      ...(target.user ? { user: target.user } : {}),
      env: this.execEnv(),
      stdin: JSON.stringify(spec),
      onStdout: (chunk) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      },
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (buf.trim()) handleLine(buf);

    if (errorMsg) {
      if (errorAuth) throw new EngineAuthError(errorMsg, errorSession);
      throw new Error(`in-sandbox engine turn failed: ${errorMsg}`);
    }
    if (!result) {
      throw new Error(
        `in-sandbox engine turn produced no result (exit ${exec.exitCode}); stderr: ${exec.stderr.slice(0, 800)}`,
      );
    }
    return result;
  }

  /**
   * Bidirectional (tool-bridge) path: stdin stays open, the host dispatches `tool_request` frames
   * and writes `tool_response`/`tool_error` frames back until the turn ends.
   */
  private async _runBidirectional(
    args: RunEngineArgs,
    target: NonNullable<RunEngineArgs['target']>,
    spec: object,
  ): Promise<EngineRunResult> {
    const bridge = args.toolBridge!;

    let stdinWrite!: (data: string) => void;
    let stdinEnd!: () => void;

    let result: EngineRunResult | undefined;
    let errorMsg: string | undefined;
    let errorAuth = false;
    let errorSession: string | undefined;

    const host = new ToolBridgeHost(
      bridge,
      (line) => stdinWrite(line),
      () => stdinEnd(),
    );

    host.onFrame((frame: InboundFrame) => {
      if (frame.t === 'event') args.onEvent?.(frame.e as EngineEvent);
      else if (frame.t === 'final') result = frame.r as EngineRunResult;
      else if (frame.t === 'error') {
        errorMsg = frame.message;
        errorAuth = !!frame.auth;
        errorSession = frame.sessionId;
      }
    });

    const exec = await this.containers.exec(target.containerId, ['atlas-engine-turn'], {
      ...(target.user ? { user: target.user } : {}),
      env: this.execEnv(),
      onStdinReady: (write, end) => {
        stdinWrite = write;
        stdinEnd = end;
        // Write the initial turn spec then leave stdin open.
        write(`${JSON.stringify(spec)}\n`);
      },
      onStdout: (chunk) => host.feedChunk(chunk),
      ...(args.signal ? { signal: args.signal } : {}),
    });

    host.flush();
    // The exec has already EXITED (awaited above), so all stdout has been fed to the host. Normally a
    // closing `final`/`error` frame has already resolved `host.closed`. But a crashed engine (e.g. a
    // module-load error) exits WITHOUT emitting any frame — then `host.closed` would never resolve and
    // this `await` would hang the turn (and the thread's serialized turn queue) forever. Bound the wait:
    // on timeout we fall through to the `!result` check below and surface the exit + stderr as an error.
    await Promise.race([host.closed, new Promise((resolve) => setTimeout(resolve, 2000))]);

    if (errorMsg) {
      if (errorAuth) throw new EngineAuthError(errorMsg, errorSession);
      throw new Error(`in-sandbox engine turn failed: ${errorMsg}`);
    }
    if (!result) {
      throw new Error(
        `in-sandbox engine turn produced no result (exit ${exec.exitCode}); stderr: ${exec.stderr.slice(0, 800)}`,
      );
    }
    return result;
  }

  /** Credentials + engine config the in-container EngineCore reads from process.env (per-exec, ephemeral). */
  private execEnv(): Record<string, string> {
    const e: Record<string, string> = {};
    const put = (key: string, value: string | number | boolean | undefined): void => {
      if (value !== undefined && value !== null) e[key] = String(value);
    };
    put('ANTHROPIC_API_KEY', this.env.get('ANTHROPIC_API_KEY'));
    put('ENGINE_AUTH_MODE', this.env.get('ENGINE_AUTH_MODE'));
    put('CLAUDE_OAUTH_TOKEN', this.env.get('CLAUDE_OAUTH_TOKEN'));
    put('WORKER_MODEL', this.env.get('WORKER_MODEL'));
    put('WORKER_MODEL', this.env.get('WORKER_MODEL'));
    put('CODEX_MODEL', this.env.get('CODEX_MODEL'));
    put('CODEX_MODEL', this.env.get('CODEX_MODEL'));
    // The agent home is INSIDE the container (long-lived container → resume across turns).
    e.AGENT_HOME_ROOT = CONTAINER_AGENT_HOME;
    return e;
  }
}
