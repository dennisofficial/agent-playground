import { CreateModule } from '@workspace/nestjs-core';
import { ChannelModule } from '../channel/channel.module';
import { EmployeesModule } from '../employees/employees.module';
import { GateModule } from '../gate/gate.module';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { RecursionGuardModule } from '../recursion-guard/recursion-guard.module';
import { SessionsModule } from '../sessions/sessions.module';
import { ToolsModule } from '../tools/tools.module';
import { WorktreesModule } from '../worktrees/worktrees.module';
import { BotGraphFactory } from './bot-graph.factory';

/**
 * The bot's TURN GRAPH (its "brain"): `BotGraphFactory` compiles one LangGraph state machine per
 * employee — gate → loop_guard → recall → llm ⇄ tools → reconcile (see bot-graph.factory.ts). This
 * module owns the graph and every dependency the NODES need (gate, recursion guard, memory/fetch +
 * checkpointer, llm, tools, worktrees, sessions, persona). The conductor imports this and stays
 * concerned only with the event loop — it no longer pulls in the graph's node-only dependencies.
 */
@CreateModule({
  imports: [
    ChannelModule,
    EmployeesModule,
    GateModule,
    LlmModule,
    MemoryModule,
    RecursionGuardModule,
    SessionsModule,
    ToolsModule,
    WorktreesModule,
  ],
  services: [BotGraphFactory],
  exports: [BotGraphFactory],
})
export class BotGraphModule {}
