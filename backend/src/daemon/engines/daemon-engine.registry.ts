import { Injectable, Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ClaudeEngine } from '@harness/engines/claude.engine';
import { CodexEngine } from '@harness/engines/codex.engine';
import {
  WorkerEngine,
  EWorkerEngineName,
} from '@harness/engines/worker-engine.port';

/**
 * The daemon's engine registry — a LANGGRAPH-FREE copy of the host `EngineRegistry`
 * ([engine.registry.ts](../../harness/engines/engine.registry.ts)). Same name→instance-via-DI
 * shape, but the map omits the `langgraph` entry so this file never imports `LanggraphEngine`
 * (which pulls the Postgres checkpointer — and the daemon has NO database).
 *
 * Only registered-project CODING sessions containerize, and those run Claude or Codex; langgraph
 * chat/conductor stays host-side. So a `langgraph` dispatch reaching the daemon is a routing bug —
 * `get()` throws loudly rather than silently degrading.
 */
const DAEMON_ENGINE_CLASSES: Partial<
  Record<EWorkerEngineName, Type<WorkerEngine>>
> = {
  [EWorkerEngineName.CLAUDE]: ClaudeEngine,
  [EWorkerEngineName.CODEX]: CodexEngine,
};

@Injectable()
export class DaemonEngineRegistry {
  constructor(private readonly moduleRef: ModuleRef) {}

  get(name: EWorkerEngineName): WorkerEngine {
    const cls = DAEMON_ENGINE_CLASSES[name];
    if (!cls)
      throw new Error(
        `Engine '${name as string}' is not available in the daemon (only claude/codex containerize; langgraph stays host-side).`,
      );
    return this.moduleRef.get(cls);
  }
}
