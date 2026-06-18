import { Injectable, Logger } from '@nestjs/common';
import { AgentToolSourceResolver } from '../skills/agent-tool-source-resolver.service';
import {
  EWorkerEngineName,
  type EngineRunResult,
  type RunWorkerArgs,
} from '../engines/worker-engine.port';
import { DaemonClient } from './daemon-client';
import type { RunCommandPayload } from './daemon-protocol';
import { SandboxReadinessService } from './sandbox-readiness.service';
import { SandboxRegistry } from './sandbox-registry';
import type { TurnRoutingCtx } from './turn-executor.service';

/**
 * The REMOTE branch of `TurnExecutor` (Phase 7) — dispatches an engine turn to the workspace's
 * in-sandbox daemon over Redis instead of running it on the host. DORMANT this phase (`isContainerized`
 * is hard-false, so nothing routes here at runtime); exercised only by unit tests with fakes until
 * Phase 9 flips the policy on.
 *
 * It:
 *  1. resolves (and lazily ensures) the sandbox for the session's `(team, project)` via
 *     `SandboxRegistry.resolveForSession` → the `workspaceId` to dispatch to;
 *  1b. GATES on readiness: `SandboxReadinessService.waitForReady(workspaceId)` blocks the FIRST turn to
 *     a freshly-spawned sandbox until its daemon signals ready (inner Docker up + consumer loop running),
 *     so we never dispatch a `docker compose` turn before the engine is reachable. Cached after the first;
 *  2. resolves the agent's host-side tool INPUTS (skill sources + MCP servers) via
 *     `AgentToolSourceResolver.forAgent` — the daemon has no DB, so the host ships these;
 *  3. builds the `RunCommandPayload` from `args` MINUS `onEvent`/`signal`/`cwd` (functions don't cross
 *     the wire; the daemon overrides cwd with the owned worktree path) PLUS `engine`, the harness
 *     `sessionId` (the daemon keys the worktree off it), `resumeSessionId` (the engine's own resume
 *     handle = `args.sessionId`), `skillSources`, and `mcpServers`;
 *  4. calls `DaemonClient.dispatchRun(workspaceId, payload, args.onEvent, args.signal)` — which streams
 *     each `WorkerEvent` to `onEvent`, bridges `signal`→abort, and resolves with the same
 *     `EngineRunResult` shape `WorkerEngine.run` returns.
 */
@Injectable()
export class RemoteTurnDispatcher {
  private readonly logger = new Logger(RemoteTurnDispatcher.name);

  constructor(
    private readonly sandboxes: SandboxRegistry,
    private readonly toolSources: AgentToolSourceResolver,
    private readonly daemon: DaemonClient,
    private readonly readiness: SandboxReadinessService,
  ) {}

  async dispatch(
    ctx: TurnRoutingCtx,
    engineName: EWorkerEngineName,
    args: RunWorkerArgs,
  ): Promise<EngineRunResult> {
    // langgraph never containerizes (chat/conductor stay host-side); the daemon only runs claude/codex.
    if (engineName === EWorkerEngineName.LANGGRAPH) {
      throw new Error(
        'RemoteTurnDispatcher: langgraph cannot run in a sandbox — it stays host-side.',
      );
    }

    // 1. Resolve (lazily ensure) the sandbox for this session's tenancy → the dispatch target.
    const sandbox = await this.sandboxes.resolveForSession({
      team: ctx.team,
      project: ctx.project,
    });

    // 1b. Gate on readiness — block the FIRST turn until the sandbox's daemon has signaled ready (inner
    // Docker up + consumer loop running), so we never dispatch a `docker compose` (or any engine) turn
    // before the daemon is reachable. Cheap + cached after the first turn; bounded — throws a clear
    // error if the daemon never readies.
    await this.readiness.waitForReady(sandbox.workspaceId);

    // 2. Host-resolve the agent's tool inputs (the daemon has no DB).
    const { skillSources, mcpServers } = await this.toolSources.forAgent(
      args.agentId,
    );

    // 3. Build the wire payload. `onEvent`/`signal`/`cwd` are intentionally OMITTED: the first two are
    // functions, and the daemon resolves cwd from the session's in-sandbox worktree. The harness
    // session id (the daemon's worktree-mapping key) is the live session id when present, else the
    // workspace id as a stable fallback.
    const harnessSessionId = ctx.session?.id ?? ctx.workspaceId ?? sandbox.workspaceId;
    const payload: RunCommandPayload = {
      engine: engineName === EWorkerEngineName.CODEX ? 'codex' : 'claude',
      sessionId: harnessSessionId,
      task: args.task,
      systemPrompt: args.systemPrompt,
      agentId: args.agentId,
      resumeSessionId: args.sessionId,
      model: args.model,
      effort: args.effort,
      mode: args.mode,
      apiKey: args.apiKey,
      skillSources,
      mcpServers,
    };

    // 4. Dispatch + stream. The daemon overrides cwd + primes tools from the shipped sources.
    return this.daemon.dispatchRun(
      sandbox.workspaceId,
      payload,
      args.onEvent,
      args.signal,
    );
  }
}
