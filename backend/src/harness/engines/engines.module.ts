import { CreateModule } from '@workspace/nestjs-core';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { SkillsModule } from '../skills/skills.module';
import { ClaudeEngine } from './claude.engine';
import { CodexEngine } from './codex.engine';
import { EngineRegistry } from './engine.registry';
import { LanggraphEngine } from './langgraph.engine';

/**
 * The pluggable worker engines (claude / codex / langgraph) behind the WorkerEngine port. The two
 * SDK engines receive their ESM-only SDKs via the @Global EsmModule's tokens; the langgraph engine
 * runs in-process on the shared Postgres checkpointer. Imports SkillsModule so each engine can read
 * its employee's resolved skills + MCP servers (`EngineHomeProvisioner.forAgent`) at run time —
 * acyclic: SkillsModule → EmployeesModule → DiscoveryModule, none import EnginesModule.
 */
@CreateModule({
  imports: [LlmModule, MemoryModule, SkillsModule],
  services: [EngineRegistry, ClaudeEngine, CodexEngine, LanggraphEngine],
})
export class EnginesModule {}
