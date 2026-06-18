import {
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createAgent } from 'langchain';
import { flattenContent } from '../domain/text';
import { ChatModelFactory } from '../llm/chat-model.factory';
import { calculateCost, extractMessageUsage } from '../llm/usage-format';
import type { MessageUsage } from '../domain/conductor-events';
import { CHECKPOINTER } from '../memory/checkpointer.module';
import { AGENT_TOOLS_PROVIDER } from './agent-tools-provider.port';
import type { IAgentToolsProvider } from './agent-tools-provider.port';
import type { McpServerConfig } from '../skills/skill.types';
import { planningTools, workerTools } from './worker-tools';
import {
  EWorkerEngineName,
  IWorkerUsage,
  RunWorkerArgs,
  WorkerEngine,
} from './worker-engine.port';

type Agent = ReturnType<typeof createAgent>;

/** Stable signature of an employee's MCP config — a changed grant produces a different key so the
 * memoized agent/client rebuild (the Phase 5 reconcile path) instead of serving stale tools. */
function mcpSignature(servers: ReadonlyArray<McpServerConfig>): string {
  return JSON.stringify(servers);
}

/** Map our engine-neutral MCP config to the mcp-adapters connection record (keyed by server name). */
function toMcpConnections(
  servers: ReadonlyArray<McpServerConfig>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const s of servers) {
    out[s.name] =
      s.transport === 'stdio'
        ? {
            transport: 'stdio',
            command: s.command,
            ...(s.args ? { args: s.args } : {}),
            ...(s.env ? { env: s.env } : {}),
          }
        : {
            transport: 'http',
            url: s.url,
            ...(s.headers ? { headers: s.headers } : {}),
          };
  }
  return out;
}

/**
 * The original hand-rolled ReAct worker, one engine behind the WorkerEngine interface. Kept so the
 * harness can compare the custom LangGraph agent against Codex and Claude on the same task.
 */
@Injectable()
export class LanggraphEngine implements WorkerEngine {
  readonly name = EWorkerEngineName.LANGGRAPH;
  private readonly logger = new Logger(LanggraphEngine.name);

  // Agents memoized by the planning flag for employees WITHOUT MCP (the common path — same toolset
  // for every such employee). They share the checkpointer, so a session can switch mode between turns
  // (plan one turn, execute the next) and the other-mode agent resumes the same thread.
  private baseAgents = new Map<boolean, Agent>();
  // Per-employee agents (keyed `${agentId}:${readOnly}`) for employees WITH MCP servers — their
  // toolset includes that employee's MCP tools, so they can't share the base agents.
  private mcpAgents = new Map<string, Agent>();
  // One MCP client per employee (keyed `${agentId}:${signature}`) — reused across turns; a changed
  // signature builds a fresh client (the stale one is closed) so a runtime grant change takes effect.
  private mcpClients = new Map<string, MultiServerMCPClient>();
  private threadCounter = 0;

  constructor(
    @Inject(CHECKPOINTER) private readonly checkpointer: PostgresSaver,
    private readonly models: ChatModelFactory,
    @Inject(AGENT_TOOLS_PROVIDER)
    private readonly provisioner: IAgentToolsProvider,
  ) {}

  // A read-only turn (plan or investigate) gets a READ-ONLY tool set (no write_file/str_replace/bash)
  // so it physically cannot mutate the workspace — matching the engine-enforced read-only of the
  // claude/codex read-only turns. LangGraph has no separate plan ceremony, so plan and investigate
  // share the read-only agent; only their opening-prompt framing differs.
  private async getAgent(agentId: string, readOnly: boolean): Promise<Agent> {
    const builtins = readOnly ? planningTools : workerTools;
    const mcp = this.provisioner.forAgent(agentId).mcpServers;
    if (!mcp.length) {
      let a = this.baseAgents.get(readOnly);
      if (!a) {
        a = createAgent({
          model: this.models.buildModel(),
          tools: builtins,
          checkpointer: this.checkpointer,
        });
        this.baseAgents.set(readOnly, a);
      }
      return a;
    }

    const sig = mcpSignature(mcp);
    const key = `${agentId}:${readOnly}:${sig}`;
    let a = this.mcpAgents.get(key);
    if (!a) {
      const mcpTools = await this.loadMcpTools(agentId, mcp, sig);
      a = createAgent({
        model: this.models.buildModel(),
        tools: [...builtins, ...mcpTools],
        checkpointer: this.checkpointer,
      });
      this.mcpAgents.set(key, a);
    }
    return a;
  }

  /** Load this employee's MCP tools, reusing a per-employee client. Resilient: a server that won't
   * connect is logged and the turn proceeds on the built-in tools rather than failing. */
  private async loadMcpTools(
    agentId: string,
    servers: ReadonlyArray<McpServerConfig>,
    sig: string,
  ): Promise<Awaited<ReturnType<MultiServerMCPClient['getTools']>>> {
    const clientKey = `${agentId}:${sig}`;
    let client = this.mcpClients.get(clientKey);
    if (!client) {
      // Signature changed → retire any prior client for this employee (best-effort close) before
      // building the new one, so a runtime grant change doesn't leak the old connections.
      for (const [k, old] of this.mcpClients) {
        if (k.startsWith(`${agentId}:`)) {
          void old.close().catch(() => {});
          this.mcpClients.delete(k);
        }
      }
      client = new MultiServerMCPClient(
        toMcpConnections(servers) as never,
      );
      this.mcpClients.set(clientKey, client);
    }
    try {
      return await client.getTools();
    } catch (err) {
      this.logger.warn(
        `MCP tools unavailable for ${agentId} (${err instanceof Error ? err.message : String(err)}) — proceeding with built-in tools only`,
      );
      return [];
    }
  }

  async run({
    task,
    systemPrompt,
    agentId,
    sessionId,
    mode,
    onEvent,
    signal,
  }: RunWorkerArgs) {
    const threadId =
      sessionId ??
      `lg-${(++this.threadCounter).toString().padStart(3, '0')}-${Date.now()}`;
    // LangGraph has no native skill packages, so this employee's resolved skill listing rides in the
    // seeded system prefix (first turn only — resumes carry it in the checkpointed history).
    const skillsPrompt = this.provisioner.forAgent(agentId).skillsPrompt;
    const systemText = skillsPrompt
      ? `${systemPrompt}\n\n${skillsPrompt}`
      : systemPrompt;
    // createAgent takes no per-invoke system prompt, so seed it as a leading SystemMessage on the
    // first turn only (resumes already carry it in the checkpointed history).
    const messages: BaseMessage[] = sessionId
      ? [new HumanMessage(task)]
      : [
          // Cache the worker's system prefix. Workers loop many times, so without a breakpoint the
          // persona is re-sent uncached on every iteration. ttl:'1h' survives long single tool calls.
          new SystemMessage({
            content: [
              {
                type: 'text',
                text: systemText,
                cache_control: { type: 'ephemeral', ttl: '1h' },
              },
            ],
          }),
          new HumanMessage(task),
        ];

    let lastText = '';
    // Accumulate token usage across all AI messages in this turn.
    const accUsage: MessageUsage = { input: 0, output: 0 };

    // streamMode 'updates' yields complete messages per node step (not token chunks), which maps
    // cleanly onto WorkerEvents. The update keys are node names; we don't depend on them.
    const agent = await this.getAgent(agentId, mode !== 'execute');
    const stream = await agent.stream(
      { messages },
      {
        configurable: { thread_id: threadId },
        streamMode: 'updates',
        recursionLimit: 50,
        signal,
      },
    );
    for await (const update of stream as AsyncIterable<
      Record<string, { messages?: BaseMessage[] }>
    >) {
      for (const payload of Object.values(update)) {
        for (const m of payload?.messages ?? []) {
          if (m.getType() !== 'ai') continue;
          const text = flattenContent(m.content).trim();
          if (text) {
            onEvent({ kind: 'text', text });
            lastText = text;
          }
          for (const c of (m as { tool_calls?: { name: string }[] })
            .tool_calls ?? []) {
            onEvent({ kind: 'tool', name: c.name });
          }
          // Accumulate token usage from every AI message (each step has usage_metadata).
          const u = extractMessageUsage(m);
          if (u) {
            accUsage.input += u.input;
            accUsage.output += u.output;
            accUsage.cacheRead = (accUsage.cacheRead ?? 0) + (u.cacheRead ?? 0);
            accUsage.cacheWrite5m =
              (accUsage.cacheWrite5m ?? 0) + (u.cacheWrite5m ?? 0);
            accUsage.cacheWrite1h =
              (accUsage.cacheWrite1h ?? 0) + (u.cacheWrite1h ?? 0);
          }
        }
      }
    }

    const result = lastText || '(no summary)';
    onEvent({ kind: 'result', text: result });

    // Build IWorkerUsage from the accumulated counts. LangGraph always uses the chat model (the
    // engine ignores `turnModel` — `getAgent` calls `this.models.buildModel()` unconditionally).
    let workerUsage: IWorkerUsage | undefined;
    if (accUsage.input > 0 || accUsage.output > 0) {
      const modelId = this.models.chatModelId();
      const cacheRead = accUsage.cacheRead ?? 0;
      const cacheWrite5m = accUsage.cacheWrite5m ?? 0;
      const cacheWrite1h = accUsage.cacheWrite1h ?? 0;
      const cacheWrite = cacheWrite5m + cacheWrite1h;
      const costUsd = calculateCost(modelId, accUsage);
      workerUsage = {
        // LangChain's usage_metadata already folds cache tokens into `input_tokens` (grand total).
        inputTokens: accUsage.input,
        outputTokens: accUsage.output,
        ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
        costUsd,
        model: modelId,
      };
    }

    return {
      result,
      sessionId: threadId,
      ...(workerUsage ? { usage: workerUsage } : {}),
    };
  }
}
