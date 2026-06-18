import { Inject, Injectable, Logger } from '@nestjs/common';
import { EWorkerEngineName } from '@harness/engines/worker-engine.port';
import {
  abortChannel,
  eventStream,
  type RunCommand,
  type RunErrorFrame,
  type RunEventFrame,
  type RunResultFrame,
} from '@harness/workspaces/daemon-protocol';
import {
  REDIS_STREAM_PORT,
  type RedisStreamPort,
} from '../../_lib/redis/redis.port';
import { DaemonEngineRegistry } from '../engines/daemon-engine.registry';
import { DaemonAgentToolsProvider } from '../engines/daemon-agent-tools-provider.service';
import { DaemonGitService } from '../git/daemon-git.service';

/**
 * Reconstitutes a HOST `engines.get(engine).run({...})` call INSIDE the sandbox from a 'run' command.
 *
 * This is the daemon's "Claude Code" turn handler — the in-container counterpart to
 * `SessionRunnerService.runSessionTurn`'s engine call ([session-runner.service.ts:277]). The wire
 * payload carries everything that crosses (`RunWorkerArgs` minus the three non-wire fields). Here we
 * supply the three the host dropped:
 *  - `cwd`   → the session's own worktree path (ensure-or-get via `DaemonGitService`), so the engine
 *              is jailed to its checkout exactly like the host jails it to `workspace.path`.
 *  - `onEvent` → XADD each progress event onto `run:{cid}:events` so the host's tail relays it.
 *  - `signal`  → a per-correlationId `AbortController`, fired by a PUBLISH on `run:{cid}:abort`.
 *
 * On resolve it XADDs the terminal `result` frame; on throw, the `error` frame. The abort subscription
 * is always torn down. The DB is never touched — tools are `prime`d from the host-shipped inputs.
 */
@Injectable()
export class DaemonTurnService {
  private readonly logger = new Logger(DaemonTurnService.name);

  constructor(
    private readonly engines: DaemonEngineRegistry,
    private readonly tools: DaemonAgentToolsProvider,
    private readonly git: DaemonGitService,
    @Inject(REDIS_STREAM_PORT) private readonly redis: RedisStreamPort,
  ) {}

  async handleRun(cmd: RunCommand): Promise<void> {
    const { correlationId, payload } = cmd;
    const events = eventStream(correlationId);
    const ac = new AbortController();
    let unsubscribe: (() => Promise<void>) | undefined;

    try {
      // 1) Materialize this agent's skills/MCP from the host-shipped inputs (no DB in the sandbox).
      await this.tools.prime(payload.agentId, {
        skillSources: payload.skillSources,
        mcpServers: payload.mcpServers,
      });

      // 2) Resolve cwd = the session's worktree (create on first turn, else reuse). `createWorktree`
      //    is idempotent — it returns the existing checkout path when one already exists.
      const cwd =
        this.git.worktreePath(payload.sessionId) ??
        (await this.git.createWorktree(payload.sessionId));

      // 3) Bridge the abort channel → this run's controller. Subscribe BEFORE the run starts so an
      //    abort published during a slow boot still aborts it.
      unsubscribe = await this.redis.subscribe(
        abortChannel(correlationId),
        () => {
          this.logger.log(`run ${correlationId}: abort received`);
          ac.abort();
        },
      );

      // 4) Reconstitute the engine run. `onEvent` streams to the host; everything else is verbatim
      //    from the payload (the engine name routes through the langgraph-free daemon registry).
      const engine = this.engines.get(payload.engine as EWorkerEngineName);
      const ret = await engine.run({
        task: payload.task,
        cwd,
        systemPrompt: payload.systemPrompt,
        agentId: payload.agentId,
        sessionId: payload.resumeSessionId,
        model: payload.model,
        effort: payload.effort,
        mode: payload.mode,
        apiKey: payload.apiKey,
        onEvent: (event) => {
          const frame: RunEventFrame = { kind: 'event', event };
          void this.redis
            .xadd(events, frame)
            .catch((err) =>
              this.logger.warn(
                `run ${correlationId}: event XADD failed: ${String(err)}`,
              ),
            );
        },
        signal: ac.signal,
      });

      // 5) Terminal success — the engine `run()` return shape, serialized verbatim.
      const result: RunResultFrame = {
        kind: 'result',
        result: ret.result,
        sessionId: ret.sessionId,
        questions: ret.questions,
        planText: ret.planText,
        usage: ret.usage,
      };
      await this.redis.xadd(events, result);
      this.logger.log(`run ${correlationId}: completed (${payload.engine})`);
    } catch (err) {
      const error: RunErrorFrame = {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
      // Best-effort terminal error frame — if even this XADD fails, the host's tail keeps blocking
      // until its own timeout, but the run is logged here regardless.
      await this.redis
        .xadd(events, error)
        .catch((e) =>
          this.logger.error(
            `run ${correlationId}: error XADD failed: ${String(e)}`,
          ),
        );
      this.logger.error(`run ${correlationId}: failed — ${error.message}`);
    } finally {
      if (unsubscribe) await unsubscribe().catch(() => undefined);
    }
  }
}
