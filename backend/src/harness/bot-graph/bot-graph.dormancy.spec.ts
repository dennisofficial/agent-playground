import { type BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { EnvService } from '@core/config/env/env.service';
import { describe, expect, it } from 'vitest';
import { makeEmployee } from '@harness/employees/employee.testing';
import type { ChannelRegistryService } from '../channel/channel-registry.service';
import type { ChannelService } from '../channel/channel.service';
import type { ChannelMsg } from '../channel/channel.types';
import type { GateDecision } from '../gate/gate.service';
import type { GateService } from '../gate/gate.service';
import type { ChatModelFactory } from '../llm/chat-model.factory';
import type { FetchService } from '../memory/fetch.service';
import type { ReconcileService } from '../memory/reconcile.service';
import type { RecursionGuardService } from '../recursion-guard/recursion-guard.service';
import type { SessionRegistry } from '../sessions/session-registry.port';
import type { PersonaService } from '../employees/persona.service';
import type { ToolRegistry } from '../tools/tool.registry';
import type { WorktreeService } from '../worktrees/worktree.service';
import { BotGraphFactory } from './bot-graph.factory';

/**
 * Dormancy wiring at the graph level:
 *  - the gate node derives `dormant` from `consecutiveSoftIgnores` vs the threshold (default 3) and
 *    passes it to the gate;
 *  - a dormant cheap-ignore (`dormantSkip`) ends the turn at `mark_seen` WITHOUT reaching reconcile;
 *  - a normal ignore still reaches reconcile (the reminder backstop is preserved).
 */

const ALEX = makeEmployee({
  id: 'alex',
  name: 'Alex',
  role: 'backend engineer',
});

class FakeChannel {
  readonly surfaceId = 'tui:test';
  private log: ChannelMsg[] = [];
  private nextSeq = 0;
  append(
    msg: Omit<ChannelMsg, 'seq' | 'channelId' | 'createdAt'> & {
      channelId?: string;
    },
  ): ChannelMsg {
    const full: ChannelMsg = {
      ...msg,
      channelId: msg.channelId ?? this.surfaceId,
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
  subscribe(): () => void {
    return () => {};
  }
}

function buildFactory(
  channel: FakeChannel,
  gate: (
    bot: unknown,
    text: string,
    opts: { dormant?: boolean },
  ) => Promise<GateDecision>,
  reconcileTasks: () => Promise<void>,
): BotGraphFactory {
  return new BotGraphFactory(
    channel as unknown as ChannelService,
    { get: () => undefined } as unknown as ChannelRegistryService,
    {
      toStructuredTools: () => [],
      terminalToolNames: () => new Set<string>(),
      refreshScopesByName: () => new Map(),
    } as unknown as ToolRegistry,
    { gate } as unknown as GateService,
    { isEnabled: () => false } as unknown as RecursionGuardService,
    {
      fetchMemory: () => Promise.resolve(''),
      fetchTasks: () => Promise.resolve(''),
      fetchContext: () => Promise.resolve(''),
    } as unknown as FetchService,
    {
      reconcileMemory: () => Promise.resolve(),
      reconcileTasks,
    } as unknown as ReconcileService,
    {
      buildModel: () => ({
        bindTools: () => ({
          invoke: () =>
            Promise.reject(new Error('llm must not run on the ignore path')),
        }),
      }),
    } as unknown as ChatModelFactory,
    { chatPromptFor: () => 'persona' } as unknown as PersonaService,
    { list: () => [] } as unknown as WorktreeService,
    { list: () => Promise.resolve([]) } as unknown as SessionRegistry,
    new MemorySaver() as unknown as PostgresSaver,
    { get: () => undefined } as unknown as EnvService, // DORMANCY_ENABLED default true, threshold 3
  );
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const item of stream) void item;
}

const seedHuman = (channel: FakeChannel) =>
  channel.append({
    id: 'h-1',
    author: 'Dennis',
    authorId: 'dennis',
    text: 'hello',
  });

describe('bot graph — dormancy', () => {
  it('passes dormant=true to the gate at/above the ignore threshold', async () => {
    const channel = new FakeChannel();
    seedHuman(channel);
    let seenDormant: boolean | undefined;
    const factory = buildFactory(
      channel,
      (_b, _t, opts) => {
        seenDormant = opts.dormant;
        return Promise.resolve({ action: 'ignore' });
      },
      () => Promise.resolve(),
    );
    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:dorm-on:root' } };
    await graph.updateState(config, { consecutiveSoftIgnores: 3, cursor: 0 });
    await drain(
      await graph.stream(
        { cursor: 0, forced: false },
        { ...config, streamMode: 'updates' as const },
      ),
    );
    expect(seenDormant).toBe(true);
  });

  it('passes dormant=false below the threshold', async () => {
    const channel = new FakeChannel();
    seedHuman(channel);
    let seenDormant: boolean | undefined;
    const factory = buildFactory(
      channel,
      (_b, _t, opts) => {
        seenDormant = opts.dormant;
        return Promise.resolve({ action: 'ignore' });
      },
      () => Promise.resolve(),
    );
    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:dorm-off:root' } };
    await graph.updateState(config, { consecutiveSoftIgnores: 2, cursor: 0 });
    await drain(
      await graph.stream(
        { cursor: 0, forced: false },
        { ...config, streamMode: 'updates' as const },
      ),
    );
    expect(seenDormant).toBe(false);
  });

  it('dormant off-lane skip ends at mark_seen WITHOUT reconcile, cursor advanced', async () => {
    const channel = new FakeChannel();
    seedHuman(channel);
    let reconcileCalls = 0;
    const factory = buildFactory(
      channel,
      () => Promise.resolve({ action: 'ignore', dormantSkip: true }),
      () => {
        reconcileCalls++;
        return Promise.resolve();
      },
    );
    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:dorm-skip:root' } };
    await drain(
      await graph.stream(
        { cursor: 0, forced: false },
        { ...config, streamMode: 'updates' as const },
      ),
    );
    expect(reconcileCalls).toBe(0); // reconcile skipped — zero LLM cost on the off-lane ignore
    const final = await graph.getState(config);
    expect((final.values as { cursor: number }).cursor).toBe(1); // batch consumed
  });

  it('a normal ignore (no dormantSkip) still reaches reconcile', async () => {
    const channel = new FakeChannel();
    seedHuman(channel);
    let reconcileCalls = 0;
    const factory = buildFactory(
      channel,
      () => Promise.resolve({ action: 'ignore' }),
      () => {
        reconcileCalls++;
        return Promise.resolve();
      },
    );
    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:normal-ignore:root' } };
    await drain(
      await graph.stream(
        { cursor: 0, forced: false },
        { ...config, streamMode: 'updates' as const },
      ),
    );
    expect(reconcileCalls).toBe(1); // reminder backstop preserved
  });
});
