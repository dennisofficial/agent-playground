import { CreateModule } from '@workspace/nestjs-core';
import { ChannelModule } from '../channel/channel.module';
import { AddressingGate } from '../conductor/addressing-gate';
import { EmployeesModule } from '../employees/employees.module';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { RecursionGuardModule } from '../recursion-guard/recursion-guard.module';
import { SessionsModule } from '../sessions/sessions.module';
import { ToolsModule } from '../tools/tools.module';
import { WorktreesModule } from '../worktrees/worktrees.module';
import { BotGraphFactory } from './bot-graph.factory';

/**
 * The orchestrator's TURN GRAPH (Atlas's "brain"): `BotGraphFactory` compiles one LangGraph state
 * machine per bot — gate → (respond) recall → llm ⇄ tools → tool_loop_guard → reconcile, or (skip)
 * consume (see bot-graph.factory.ts). This module owns the graph and every dependency the NODES need
 * — the addressing gate (in-graph entry node), recursion/tool-loop guard, memory/fetch + checkpointer,
 * llm, tools, worktrees, sessions, persona. The conductor imports this and stays concerned only with
 * the event loop. (`AddressingGate` lives here, not in the conductor, because the gate is now a node.)
 */
@CreateModule({
  imports: [
    ChannelModule,
    EmployeesModule,
    LlmModule,
    MemoryModule,
    RecursionGuardModule,
    SessionsModule,
    ToolsModule,
    WorktreesModule,
  ],
  services: [AddressingGate, BotGraphFactory],
  exports: [BotGraphFactory],
})
export class BotGraphModule {}
