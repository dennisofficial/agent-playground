import { EnvService } from '@core/config/env/env.service';
import { END, START, StateGraph } from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ChannelRegistryService } from '../channel/channel-registry.service';
import { ChannelService } from '../channel/channel.service';
import type { EmployeeDefinition } from '../employees/employee.types';
import { PersonaService } from '../employees/persona.service';
import { GateService } from '../gate/gate.service';
import { ChatModelFactory } from '../llm/chat-model.factory';
import { CHECKPOINTER } from '../memory/checkpointer.module';
import { CompactionSummaryStore } from '../memory/compaction-summary.store';
import { FetchService } from '../memory/fetch.service';
import { ReconcileService } from '../memory/reconcile.service';
import { RecursionGuardService } from '../recursion-guard/recursion-guard.service';
import {
  SESSION_REGISTRY,
  type SessionRegistry,
} from '../sessions/session-registry.port';
import { EngineToolFactory } from '../tools/engine-tool.factory';
import { ToolRegistry } from '../tools/tool.registry';
import { WorktreeService } from '../worktrees/worktree.service';
import { GAP_THRESHOLD_DEFAULT_MS } from './channel-render';
import { BotState } from './bot-state';
import { BotGraphNodes } from './bot-graph.nodes';
import {
  afterGuard,
  afterLlm,
  afterMarkSeen,
  makeAfterTools,
  route,
} from './routing';

// Public surface re-exported from the graph modules so existing importers keep one entry point.
export type { BotStateDelta } from './bot-state';
export { MAX_REVISION_PASSES, revisionNote } from './read-the-room';

/**
 * A bot's TURN, as an explicit LangGraph state machine. One graph per bot, persisted on thread
 * `${bot.id}:${project}:root` (Postgres checkpointer). The conductor invokes it whenever the channel
 * has grown past the bot's cursor.
 *
 *   START → gate ─┬─ respond → loop_guard ─┬─ recall → llm ⟲ ⇄ tools → refreshContext? ─┐
 *                 │                        └─ pause ──────────────────────────────────────┤
 *                 └─ acknowledge / ignore → mark_seen ──────────────────────────────────┴→ reconcile → END
 *                                              └─ dormant off-lane skip ─────────────────────────────→ END
 *
 * Memory is DETERMINISTIC, not agentic: `recall` reads the relevant facts + open tasks IN before the
 * bot thinks, and the single `reconcile` node writes tasks OUT after — on EVERY path EXCEPT the
 * dormant off-lane skip (a dormant bot cheap-ignoring a message that named no one and hit no lane
 * keyword ends at `mark_seen` with zero LLM calls; anything about its work wakes it and reconciles
 * normally). (`llm` ⟲ is the read-the-room revision self-loop.)
 * The llm step keeps its memory/task tools too; reconcile is the state-aware backstop on top.
 *
 * THE HEART (mid-thought collaboration): the `llm` node consumes `channel.since(cursor)` at the TOP
 * of EVERY step, so a teammate's message that lands WHILE this bot is looping is folded into its
 * very next model call.
 *
 * READ-THE-ROOM (the `llm ⟲` self-loop): a final text reply is composed BLIND for one
 * model-invoke latency — a teammate answering the same broadcast can post during that window, which
 * is how four bots chorus the same news. So after `model.invoke` returns, the node synchronously
 * checks whether teammate-bot messages landed past the cursor this step consumed. If so, the reply
 * is demoted to a DRAFT (never posted, never in durable history) and the graph loops back through
 * `llm`: the teammate messages fold in via the NORMAL top-of-step read, plus a note carrying the
 * draft — post only if it still adds something, else trim or stay silent. The synchronous channel
 * makes check-then-return atomic per JS tick, so at most one bot "wins" each race round; capped at
 * MAX_REVISION_PASSES, after which the draft posts anyway (worst case = the old blind behavior).
 *
 * Cursor coordinate note: the `cursor` field rides in graph state ONLY so it threads across `llm`
 * steps within a single run. It is overwritten every invocation from the conductor's durable cursor
 * (CursorStore) passed as input. Unlike the playground (whose in-memory channel restarted at seq 0,
 * making the persisted value DEAD), the channel log + cursors are now both durable and share one
 * coordinate space — but the conductor still owns the cursor; the graph only borrows it for
 * within-run threading.
 *
 * Node IMPLEMENTATIONS live in `graph/bot-graph.nodes.ts` (BotGraphNodes); the routing predicates in
 * `graph/routing.ts`; the state shape + helpers in `graph/bot-state.ts` + `graph/message-helpers.ts`.
 * This factory owns only DI, the per-bot graph cache, and the topology wiring below.
 *
 * (Ported from playground/src/bot-graph.ts.)
 */
@Injectable()
export class BotGraphFactory {
  // One compiled graph per bot, lazy + memoized. Tenant-agnostic: the model is built per-invocation
  // inside the llm node (from the turn's credential context), so one graph serves every workspace.
  private graphs = new Map<string, ReturnType<BotGraphFactory['build']>>();
  /** The node implementations, handed the same services this factory injects. */
  private readonly nodes: BotGraphNodes;

  constructor(
    private readonly channel: ChannelService,
    private readonly channelRegistry: ChannelRegistryService,
    private readonly toolRegistry: ToolRegistry,
    private readonly gateService: GateService,
    private readonly recursionGuard: RecursionGuardService,
    private readonly fetchService: FetchService,
    private readonly reconcile: ReconcileService,
    private readonly models: ChatModelFactory,
    private readonly persona: PersonaService,
    private readonly worktrees: WorktreeService,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    @Inject(CHECKPOINTER) private readonly checkpointer: PostgresSaver,
    env: EnvService,
    // Optional so the unit specs (which construct BotGraphFactory positionally) need no change; DI
    // always provides it in the app, so tool-capabilities bind in production.
    @Optional() private readonly engineTools?: EngineToolFactory,
    @Optional() private readonly compactionStore?: CompactionSummaryStore,
  ) {
    const gapThresholdMs =
      env.get('HARNESS_TIMESTAMP_GAP_MS') ?? GAP_THRESHOLD_DEFAULT_MS;
    // DORMANCY: default-on (kill-switch via DORMANCY_ENABLED=false), threshold default 3.
    const dormancyEnabled = env.get('DORMANCY_ENABLED') !== false;
    const dormancyThreshold = env.get('DORMANCY_IGNORE_THRESHOLD') ?? 3;
    // COMPACTION (Phase 6): defaults — 50 msgs threshold, 20-msg verbatim tail.
    const compactionThreshold = env.get('COMPACTION_THRESHOLD') ?? 50;
    const compactionTail = env.get('COMPACTION_TAIL') ?? 20;
    this.nodes = new BotGraphNodes(
      this.channel,
      this.channelRegistry,
      this.toolRegistry,
      this.gateService,
      this.recursionGuard,
      this.fetchService,
      this.reconcile,
      this.models,
      this.persona,
      this.worktrees,
      this.sessions,
      gapThresholdMs,
      dormancyEnabled,
      dormancyThreshold,
      this.engineTools,
      compactionThreshold,
      compactionTail,
      this.compactionStore,
    );
  }

  getBotGraph(bot: EmployeeDefinition) {
    let g = this.graphs.get(bot.id);
    if (!g) {
      g = this.build(bot);
      this.graphs.set(bot.id, g);
    }
    return g;
  }

  private build(bot: EmployeeDefinition) {
    const n = this.nodes.forBot(bot);
    // Phase 6: `compact` runs sequentially after `reconcile` on every path (a cheap threshold
    // check first — no LLM call unless COMPACTION_THRESHOLD has been crossed). Both checkpoint
    // their state changes before END.
    //
    // Topology (updated):
    //   START → gate ─┬─ respond → loop_guard ─┬─ recall → llm ⇄ tools → refreshContext? ─┐
    //                 │                        └─ pause ──────────────────────────────────┤
    //                 └─ acknowledge / ignore → mark_seen ──────────────────────────────┴→ reconcile → compact → END
    //                                              └─ dormant off-lane skip ───────────────────────────────────────→ END
    return new StateGraph(BotState)
      .addNode('gate', n.gate)
      .addNode('loop_guard', n.loopGuard)
      .addNode('pause', n.pause)
      .addNode('recall', n.recall)
      .addNode('llm', n.llm)
      .addNode('tools', n.tools)
      .addNode('refreshContext', n.refreshContext)
      .addNode('mark_seen', n.markSeen)
      .addNode('reconcile', n.reconcile)
      .addNode('compact', n.compact)
      .addEdge(START, 'gate')
      .addConditionalEdges('gate', route, ['loop_guard', 'mark_seen'])
      .addConditionalEdges('loop_guard', afterGuard, ['recall', 'pause'])
      .addEdge('recall', 'llm')
      .addConditionalEdges('llm', afterLlm, ['tools', 'llm', 'reconcile'])
      .addConditionalEdges('tools', makeAfterTools(n.terminal, n.refresh), [
        'llm',
        'refreshContext',
        'reconcile',
      ])
      .addEdge('refreshContext', 'llm')
      .addConditionalEdges('mark_seen', afterMarkSeen, ['reconcile', END])
      .addEdge('pause', 'reconcile')
      .addEdge('reconcile', 'compact')
      .addEdge('compact', END)
      .compile({ checkpointer: this.checkpointer });
  }
}
