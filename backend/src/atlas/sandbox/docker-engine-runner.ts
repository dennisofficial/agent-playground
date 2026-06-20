import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EngineAuthError,
  type EngineEvent,
  type EngineRunResult,
  type EngineRunnerPort,
  type RunEngineArgs,
} from '../engine';
import { CONTAINER_ENGINE, type ContainerEngine } from './container-engine.port';

/** The engine's isolated agent home INSIDE the sandbox (long-lived → session resume across turns). */
export const CONTAINER_AGENT_HOME = '/atlas-home';

/** One NDJSON frame the in-container entrypoint emits. */
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
    };

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
        // Non-JSON noise on stdout (shouldn't happen — diagnostics go to stderr) — ignore.
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
    if (buf.trim()) handleLine(buf); // a trailing frame without a newline

    if (errorMsg) {
      // Auth (401) → a resumable EngineAuthError carrying the live session, so the driver pauses
      // (not fails) and a re-ping continues the same in-sandbox session.
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
    put('ATLAS_ENGINE_AUTH_MODE', this.env.get('ATLAS_ENGINE_AUTH_MODE'));
    put('ATLAS_CLAUDE_OAUTH_TOKEN', this.env.get('ATLAS_CLAUDE_OAUTH_TOKEN'));
    put('ATLAS_WORKER_MODEL', this.env.get('ATLAS_WORKER_MODEL'));
    put('WORKER_MODEL', this.env.get('WORKER_MODEL'));
    put('ATLAS_CODEX_MODEL', this.env.get('ATLAS_CODEX_MODEL'));
    put('CODEX_MODEL', this.env.get('CODEX_MODEL'));
    // The agent home is INSIDE the container (long-lived container → resume across turns).
    e.ATLAS_AGENT_HOME_ROOT = CONTAINER_AGENT_HOME;
    return e;
  }
}
