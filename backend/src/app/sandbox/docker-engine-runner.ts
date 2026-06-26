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
 * The worktree's mount path INSIDE the sandbox — a NEUTRAL container path, NOT the host path. The host
 * worktree is bind-mounted here so the engine never sees host-shaped paths (and can tell it is boxed);
 * `cwd` is translated host→container at the runner boundary ({@link DockerEngineRunner.toContainerCwd}).
 */
export const CONTAINER_WORKTREE = '/workspace';

/** The repo's SHARED git common dir mount path INSIDE the sandbox (linked-worktree case only). */
export const CONTAINER_GIT_COMMON = '/repo.git';

/**
 * The thread's durable SHARED CONTEXT folder INSIDE the sandbox — a per-thread scratch/working space
 * that lives OUTSIDE the git worktree (so plan/spec artifacts never pollute the repo diff). Every
 * in-sandbox session for the thread (the brain AND the plan/phase/review/auto-fix turns) reads & writes
 * here; the host reads it back via `SandboxManager.contextDirHost()`. Durable across container restarts.
 */
export const CONTAINER_CONTEXT = '/context';

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
 * driver/auto-fix/gate thread through. The worktree is bind-mounted at a NEUTRAL container path
 * (`/workspace`), so `cwd` is rewritten host→container here (see `toContainerCwd`); the git common dir
 * is mounted at `/repo.git` with a generated `.git` pointer so in-container git resolves linked worktrees.
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

    // The serializable turn spec — `cwd` is rewritten from the host worktree path onto the worktree's
    // NEUTRAL in-container mount (`/workspace`), so the in-container engine never sees a host-shaped path.
    const spec = {
      engine: args.engine,
      task: args.task,
      cwd: this.toContainerCwd(args.cwd, target),
      // The durable `/context` shared mount lives OUTSIDE the worktree, so grant it as a writable root
      // (the brain authors the plan/spec there; the worktree-only boundary would otherwise deny Write
      // and force a Bash fallback). Already a container path — no host→container rebasing needed.
      writableRoots: [CONTAINER_CONTEXT, ...(args.writableRoots ?? [])],
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

  /**
   * Map a HOST `cwd` to its path INSIDE the sandbox. The worktree is bind-mounted at
   * {@link CONTAINER_WORKTREE} (NOT same-path), so the host worktree root — and any subpath under it —
   * is rebased onto that mount. `target.worktreeHost` carries the host root; absent (a caller that
   * didn't thread it), we fall back to the worktree root, since every docker turn runs in the worktree.
   */
  private toContainerCwd(hostCwd: string, target: NonNullable<RunEngineArgs['target']>): string {
    const root = target.worktreeHost;
    if (root && (hostCwd === root || hostCwd.startsWith(`${root}/`))) {
      return `${CONTAINER_WORKTREE}${hostCwd.slice(root.length)}`;
    }
    return CONTAINER_WORKTREE;
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
    // (Engine model ids are hardcoded constants in engine-core — not passed via env.)
    // The agent home is INSIDE the container (long-lived container → resume across turns).
    e.AGENT_HOME_ROOT = CONTAINER_AGENT_HOME;
    return e;
  }
}
