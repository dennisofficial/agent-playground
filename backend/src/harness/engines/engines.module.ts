import { CreateModule } from '@workspace/nestjs-core';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { ClaudeEngine } from './claude.engine';
import { CodexEngine } from './codex.engine';
import { EngineRegistry } from './engine.registry';
import { LanggraphEngine } from './langgraph.engine';

/**
 * The pluggable worker engines (claude / codex / langgraph) behind the WorkerEngine port. The two
 * SDK engines receive their ESM-only SDKs via the @Global EsmModule's tokens; the langgraph engine
 * runs in-process on the shared Postgres checkpointer.
 */
@CreateModule({
  imports: [LlmModule, MemoryModule],
  services: [EngineRegistry, ClaudeEngine, CodexEngine, LanggraphEngine],
})
export class EnginesModule {}
