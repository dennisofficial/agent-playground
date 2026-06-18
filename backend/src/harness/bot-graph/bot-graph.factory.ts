import { EnvService } from '@core/config/env/env.service';
import { END, START, StateGraph } from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ChannelRegistryService } from '../channel/channel-registry.service';
import { ChannelService } from '../channel/channel.service';
import { AddressingGate } from '../conductor/addressing-gate';
import type { EmployeeDefinition } from '../employees/employee.types';
import { PersonaService } from '../employees/persona.service';
import { ChatModelFactory } from '../llm/chat-model.factory';
import { CHECKPOINTER } from '../memory/checkpointer.module';
import { CompactionSummaryStore } from '../memory/compaction-summary.store';
import { FetchService } from '../memory/fetch.service';
import { ReconcileService } from '../memory/reconcile.service';
import { ToolLoopGuardService } from '../recursion-guard/tool-loop-guard.service';
import {
  SESSION_REGISTRY,
  type SessionRegistry,
} from '../sessions/session-registry.port';
import { EngineToolFactory } from '../tools/engine-tool.factory';
import { ToolRegistry } from '../tools/tool.registry';
import { WorkspaceReader } from '../workspaces/workspace-reader';
import { GAP_THRESHOLD_DEFAULT_MS } from './channel-render';
import { BotState } from './bot-state';
import { BotGraphNodes } from './bot-graph.nodes';
import { afterLlm, makeAfterToolLoopGuard } from './routing';

// Public surface re-exported from the graph modules so existing importers keep one entry point.
export type { BotStateDelta } from './bot-state';
export { MAX_REVISION_PASSES, revisionNote } from './read-the-room';

/**
 * The orchestrator's TURN, as an explicit LangGraph state machine. Atlas (the single voice you talk
 * to) drives ONE graph, persisted on thread `${bot.id}:${channelId}:root` (Postgres checkpointer).
 * The conductor invokes it whenever the human thread has grown past Atlas's cursor (or a silent seed
 * wakes it).
 *
 *   START → gate → (respond) recall → llm ⇄ tools → tool_loop_guard → refreshContext? → reconcile → compact → END
 *                  (skip)    consume → END
 *
 * The `gate` node is the entry: the addressing gate runs IN-GRAPH (respond/skip classify) so a SKIP
 * lands in the same Langfuse turn trace as the work it gated. On respond it runs the normal turn; on
 * skip it routes to `consume` (advance the cursor past the gated batch, no model call). A seed / job
 * relay (`state.forced`) bypasses the classify and always responds. (`tool_loop_guard` still sits on
 * the continuation out of `tools`: a deterministic prefilter + Haiku judge that catches a single bot
 * re-issuing the SAME tool call — corrects + refreshes once, then pauses if it persists. No tool ends
 * the turn directly.)
 *
 * Memory is DETERMINISTIC, not agentic: `recall` reads the relevant facts + open tasks IN before the
 * bot thinks, and the single `reconcile` node writes tasks OUT after. The llm step keeps its
 * memory/task tools too; reconcile is the state-aware backstop on top.
 *
 * THE HEART (mid-thought collaboration): the `llm` node consumes `channel.since(cursor)` at the TOP
 * of EVERY step, so a message that lands WHILE this bot is looping is folded into its next model call.
 *
 * Node IMPLEMENTATIONS live in `bot-graph.nodes.ts` (BotGraphNodes); the routing predicates in
 * `routing.ts`; the state shape + helpers in `bot-state.ts` + `message-helpers.ts`. This factory owns
 * only DI, the per-bot graph cache, and the topology wiring below.
 *
 * (Ported from playground/src/bot-graph.ts; collapsed to the single Atlas orchestrator.)
 */
@Injectable()
export class BotGraphFactory {
  // One compiled gate-less graph per bot, lazy + memoized. Tenant-agnostic: the model is built
  // per-invocation inside the llm node (from the turn's credential context), so one graph serves
  // every workspace.
  private conductorGraphs = new Map<
    string,
    ReturnType<BotGraphFactory['buildConductorGraph']>
  >();
  /** The node implementations, handed the same services this factory injects. */
  private readonly nodes: BotGraphNodes;

  constructor(
    private readonly channel: ChannelService,
    private readonly channelRegistry: ChannelRegistryService,
    private readonly toolRegistry: ToolRegistry,
    private readonly fetchService: FetchService,
    private readonly reconcile: ReconcileService,
    private readonly models: ChatModelFactory,
    private readonly persona: PersonaService,
    private readonly workspaces: WorkspaceReader,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    @Inject(CHECKPOINTER) private readonly checkpointer: PostgresSaver,
    env: EnvService,
    // Optional so the unit specs (which construct BotGraphFactory positionally) need no change; DI
    // always provides it in the app, so tool-capabilities bind in production.
    @Optional() private readonly engineTools?: EngineToolFactory,
    // Appended last + optional so positional spec construction is untouched. DI always provides
    // these in the app; absent → compaction is skipped / the tool-loop guard is inert.
    @Optional() private readonly compactionStore?: CompactionSummaryStore,
    @Optional() private readonly toolLoopGuard?: ToolLoopGuardService,
    // The in-graph addressing gate. Optional + last for the same positional-spec reason; absent → the
    // gate node falls back to "always respond" (the unit specs' assumption).
    @Optional() private readonly gate?: AddressingGate,
  ) {
    const gapThresholdMs =
      env.get('HARNESS_TIMESTAMP_GAP_MS') ?? GAP_THRESHOLD_DEFAULT_MS;
    this.nodes = new BotGraphNodes(
      this.channel,
      this.channelRegistry,
      this.toolRegistry,
      this.fetchService,
      this.reconcile,
      this.models,
      this.persona,
      this.workspaces,
      this.sessions,
      gapThresholdMs,
      this.engineTools,
      this.compactionStore,
      this.toolLoopGuard,
      this.gate,
    );
  }

  /**
   * The orchestrator graph: START → gate → (respond) recall → llm ⇄ tools → tool_loop_guard →
   * refreshContext? → reconcile → compact → END, or (skip) consume → END. Memoized per bot id (Atlas
   * in production).
   */
  getConductorGraph(bot: EmployeeDefinition) {
    let g = this.conductorGraphs.get(bot.id);
    if (!g) {
      g = this.buildConductorGraph(bot);
      this.conductorGraphs.set(bot.id, g);
    }
    return g;
  }

  private buildConductorGraph(bot: EmployeeDefinition) {
    const n = this.nodes.forBot(bot);
    return new StateGraph(BotState)
      .addNode('gate', n.gate)
      .addNode('consume', n.consume)
      .addNode('recall', n.recall)
      .addNode('llm', n.llm)
      .addNode('tools', n.tools)
      .addNode('tool_loop_guard', n.toolLoopGuard)
      .addNode('refreshContext', n.refreshContext)
      .addNode('reconcile', n.reconcile)
      .addNode('compact', n.compact)
      .addEdge(START, 'gate')
      .addConditionalEdges('gate', n.route, ['recall', 'consume'])
      .addEdge('consume', END)
      .addEdge('recall', 'llm')
      .addConditionalEdges('llm', afterLlm, ['tools', 'llm', 'reconcile'])
      .addEdge('tools', 'tool_loop_guard')
      .addConditionalEdges(
        'tool_loop_guard',
        makeAfterToolLoopGuard(n.refresh),
        ['llm', 'refreshContext', 'reconcile'],
      )
      .addEdge('refreshContext', 'llm')
      .addEdge('reconcile', 'compact')
      .addEdge('compact', END)
      .compile({ checkpointer: this.checkpointer });
  }
}
