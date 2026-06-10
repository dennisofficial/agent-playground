import { Injectable, Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ClaudeEngine } from './claude.engine';
import { CodexEngine } from './codex.engine';
import { LanggraphEngine } from './langgraph.engine';
import type { WorkerEngine, WorkerEngineName } from './worker-engine.port';

const ENGINE_CLASSES: Record<WorkerEngineName, Type<WorkerEngine>> = {
  claude: ClaudeEngine,
  codex: CodexEngine,
  langgraph: LanggraphEngine,
};

/**
 * The engine registry: name → WorkerEngine instance, resolved through DI so each engine keeps its
 * injected dependencies (ESM SDK tokens, checkpointer, env). Adding an engine = one class + one
 * entry here; employees select theirs by name (`Employee.engine`, validated at boot).
 */
@Injectable()
export class EngineRegistry {
  constructor(private readonly moduleRef: ModuleRef) {}

  get(name: WorkerEngineName): WorkerEngine {
    const cls = ENGINE_CLASSES[name];
    if (!cls) throw new Error(`Unknown worker engine '${name as string}'`);
    return this.moduleRef.get(cls);
  }
}
