import { AIMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { EnvService } from '@core/config/env/env.service';
import type { ChannelRegistryService } from '../channel/channel-registry.service';
import type { ChannelService } from '../channel/channel.service';
import type { ChannelMsg } from '../channel/channel.types';
import type { PersonaService } from '../employees/persona.service';
import type { GateService } from '../gate/gate.service';
import type { ChatModelFactory } from '../llm/chat-model.factory';
import type { FetchService } from '../memory/fetch.service';
import type { ReconcileService } from '../memory/reconcile.service';
import type { RecursionGuardService } from '../recursion-guard/recursion-guard.service';
import type { SessionRegistry } from '../sessions/session-registry.port';
import type { ToolRegistry } from '../tools/tool.registry';
import type { WorktreeService } from '../worktrees/worktree.service';
import { BotGraphFactory } from './bot-graph.factory';
import { makeEmployee } from '@harness/employees/employee.testing';

/**
 * Pins the consume-path `recalled` reset. The ack/ignore path skips `fetch`, so before the fix the
 * previous respond turn's recall block (deleted reminder ids included) survived in the checkpoint —
 * the "phantom reminders" Sam chased for several turns in production. `consume` must overwrite it
 * with '' so the durable state never carries a stale recall.
 */

class FakeChannel {
  readonly surfaceId = 'tui:test';
  private log: ChannelMsg[] = [];
  private nextSeq = 0;
  append(msg: Omit<ChannelMsg, 'seq' | 'channelId' | 'createdAt'>): ChannelMsg {
    const full = {
      ...msg,
      channelId: this.surfaceId,
      seq: this.nextSeq++,
      createdAt: Date.now(),
    };
    this.log.push(full);
    return full;
  }
  since(cursor: number): ChannelMsg[] {
    return this.log.filter((m) => m.seq >= cursor);
  }
  lengthOf(): number {
    return this.nextSeq;
  }
  snapshot(): ChannelMsg[] {
    return [...this.log];
  }
}

const ALEX = makeEmployee({
  id: 'alex',
  name: 'Alex',
  role: 'backend engineer',
  sortOrder: 10,
});

describe('bot graph — consume path resets recalled', () => {
  it("an ack/ignore turn overwrites the prior respond turn's recall with '' in the checkpoint", async () => {
    const channel = new FakeChannel();
    const decisions: Array<'respond' | 'ignore'> = ['respond', 'ignore'];
    const factory = new BotGraphFactory(
      channel as unknown as ChannelService,
      { get: () => undefined } as unknown as ChannelRegistryService,
      {
        toStructuredTools: () => [],
        refreshScopesByName: () => new Map(),
      } as unknown as ToolRegistry,
      {
        gate: async () => ({ action: decisions.shift() ?? 'ignore' }),
      } as unknown as GateService,
      {
        isEnabled: () => false,
        windowSize: () => 12,
        detect: () => Promise.resolve({ looping: false }),
      } as unknown as RecursionGuardService,
      {
        fetchMemory: async () => '',
        fetchTasks: async () => 'On your plate:\n- [#31] call open_pr',
      } as unknown as FetchService,
      {
        reconcileMemory: async () => {},
        reconcileTasks: async () => {},
      } as unknown as ReconcileService,
      {
        buildModel: () => ({
          bindTools() {
            return this;
          },
          invoke: async () => new AIMessage({ content: 'on it' }),
        }),
      } as unknown as ChatModelFactory,
      { chatPromptFor: () => 'persona' } as unknown as PersonaService,
      { list: () => [] } as unknown as WorktreeService,
      { list: async () => [] } as unknown as SessionRegistry,
      new MemorySaver() as unknown as PostgresSaver,
      { get: () => undefined } as unknown as EnvService,
    );

    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:test:root' } };

    // Turn 1 (respond): fetch writes the recall block into durable state.
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, open the PR.',
    });
    await graph.invoke({ cursor: 0, forced: false }, config);
    expect((await graph.getState(config)).values.recalled).toContain('[#31]');

    // Turn 2 (ignored chatter): consume must reset recalled — the #31 block must NOT survive.
    channel.append({
      id: 'u-1',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'thanks all',
    });
    await graph.invoke({ cursor: 1, forced: false }, config);
    expect((await graph.getState(config)).values.recalled).toBe('');
  });
});
