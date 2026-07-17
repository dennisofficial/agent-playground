import type { Message, TurnEnvelope } from '@shared/domain';
import type { EngineRunnerPort } from '@shared/engine/engine.types';
import type { TurnChunk } from '@shared/stimulus/chunk-vocabulary';
import { describe, expect, it, vi } from 'vitest';
import type { LeaderElectionService } from '../../cluster/leader-election.service';
import type { TurnRegistry } from '../../sandbox/turn-registry.service';
import { SYSTEM_SEED_AUTHOR } from '../../surface/chat-surface.port';
import { AgentSessionManager } from '../agent-session-manager.service';

interface CollectedLike {
  pending: TurnEnvelope[];
  userChunks: unknown[];
  ids: string[];
  wake: boolean;
}

const JOB_ID = 'th-collect-001';
const ORG_ID = 'T-COLLECT';
const REPO_ID = 'repo-collect';

function msg(id: string, type: Message['type']): Message {
  return {
    id,
    orgId: ORG_ID,
    repoId: REPO_ID,
    jobId: JOB_ID,
    receivedAt: new Date().toISOString(),
    type,
  } as unknown as Message;
}

function pendingRow(
  id: string,
  priority: TurnEnvelope['priority'],
  receivedAt: Date,
): TurnEnvelope {
  return {
    message: msg(id, 'user'),
    id,
    orgId: ORG_ID,
    repoId: REPO_ID,
    jobId: JOB_ID,
    body: `body-${id}`,
    author: { id: 'U1', displayName: 'Dennis' },
    replyRoute: { surfaceId: 'web', jobRef: JOB_ID },
    receivedAt,
    ...(priority !== undefined ? { priority } : {}),
  };
}

function seedRow(id: string, receivedAt: Date): TurnEnvelope {
  return {
    message: msg(id, 'answer_question'),
    id,
    orgId: ORG_ID,
    repoId: REPO_ID,
    jobId: JOB_ID,
    body: `seed-body-${id}`,
    author: { id: SYSTEM_SEED_AUTHOR.id, displayName: 'System' },
    replyRoute: { surfaceId: 'web', jobRef: JOB_ID },
    receivedAt,
    deliveredQuestionIds: ['q1'],
  };
}

function operatorRow(id: string, receivedAt: Date): TurnEnvelope {
  return pendingRow(id, undefined as unknown as TurnEnvelope['priority'], receivedAt);
}

function makeManager(pending: TurnEnvelope[]) {
  const stimulusStore = {
    eligiblePendingChat: vi.fn().mockResolvedValue(pending),
    markChatDelivered: vi.fn().mockResolvedValue(undefined),
  };
  const turnRegistry = {} as unknown as TurnRegistry;
  const engineRunner = { run: vi.fn() } as unknown as EngineRunnerPort;
  const election = {
    getState: () => 'follower',
  } as unknown as LeaderElectionService;
  const inert = {} as never;
  const manager = new AgentSessionManager(
    inert,
    inert,
    inert,
    inert,
    inert,
    inert, // store, driverStore, autoMerge, memory, approvals, lifecycle (6)
    engineRunner, // engineRunner (7)
    turnRegistry, // turnRegistry (8)
    inert,
    inert,
    inert, // planReview, dispatcher, surface (11)
    inert, // sandboxRows (12)
    inert, // stimulusRows (13)
    stimulusStore as never, // stimulusStore (14)
    inert,
    inert,
    inert,
    inert,
    inert,
    inert,
    inert, // turnHarness…creds (21)
    inert, // mcp (McpResolver, 22)
    election, // election (23)
    inert,
    inert,
    inert,
    inert, // turnRecovery…git (27)
    { generate: () => 'SYSTEM' } as never, // prompts (28, PromptService)
    { register: () => undefined } as never, // threadInput (ThreadInputService)
    { judge: async () => undefined } as never, // liveVerificationJudge (LIVE_VERIFICATION_JUDGE)
    { getResetAt: () => undefined } as never, // usage (OauthUsageService)
    inert, // selfSufficiency
  );
  return { manager, stimulusStore };
}

describe('AgentSessionManager.collectPendingForTurn (owned coalescing selection, d18)', () => {
  it('composes ALL pending (now/queue/later) into chronological user chunks; wakes when any is wake-eligible', async () => {
    const t0 = new Date('2026-07-02T12:00:00Z');
    const t1 = new Date('2026-07-02T12:00:01Z');
    const t2 = new Date('2026-07-02T12:00:02Z');
    const pending = [
      pendingRow('a', 'now', t0),
      pendingRow('b', 'later', t1),
      pendingRow('c', 'queue', t2),
    ];
    const { manager } = makeManager(pending);

    const collected = await (
      manager as unknown as {
        collectPendingForTurn: (jobId: string) => Promise<CollectedLike | null>;
      }
    ).collectPendingForTurn(JOB_ID);

    expect(collected).not.toBeNull();
    expect(collected!.userChunks).toHaveLength(3);
    expect(collected!.ids).toEqual(['a', 'b', 'c']);
    expect(collected!.wake).toBe(true);
  });

  it('a thread whose ONLY pending row is `later`: composes it (ride-along) but does not wake', async () => {
    const pending = [pendingRow('only-later', 'later', new Date('2026-07-02T12:00:00Z'))];
    const { manager } = makeManager(pending);

    const collected = await (
      manager as unknown as {
        collectPendingForTurn: (jobId: string) => Promise<CollectedLike | null>;
      }
    ).collectPendingForTurn(JOB_ID);

    expect(collected).not.toBeNull();
    expect(collected!.userChunks).toHaveLength(1);
    expect(collected!.wake).toBe(false);
  });

  it('no pending rows: returns null', async () => {
    const { manager } = makeManager([]);

    const collected = await (
      manager as unknown as {
        collectPendingForTurn: (jobId: string) => Promise<CollectedLike | null>;
      }
    ).collectPendingForTurn(JOB_ID);

    expect(collected).toBeNull();
  });
});

describe('AgentSessionManager.collectPendingForTurn (message-agnostic coalescing: seed + operator mix as ONE batch)', () => {
  it('a seed HEAD coalesces WITH a trailing operator row — the whole batch, not a solo seed', async () => {
    const t0 = new Date('2026-07-02T12:00:00Z');
    const t1 = new Date('2026-07-02T12:00:01Z');
    const pending = [seedRow('s1', t0), operatorRow('op', t1)];
    const { manager } = makeManager(pending);

    const collected = await (
      manager as unknown as {
        collectPendingForTurn: (jobId: string) => Promise<CollectedLike | null>;
      }
    ).collectPendingForTurn(JOB_ID);

    expect(collected).not.toBeNull();
    expect(collected!.ids).toEqual(['s1', 'op']);
  });

  it('an operator HEAD coalesces the leading operator run AND a trailing seed — the whole batch', async () => {
    const t0 = new Date('2026-07-02T12:00:00Z');
    const t1 = new Date('2026-07-02T12:00:01Z');
    const t2 = new Date('2026-07-02T12:00:02Z');
    const pending = [operatorRow('a', t0), operatorRow('b', t1), seedRow('s', t2)];
    const { manager } = makeManager(pending);

    const collected = await (
      manager as unknown as {
        collectPendingForTurn: (jobId: string) => Promise<CollectedLike | null>;
      }
    ).collectPendingForTurn(JOB_ID);

    expect(collected).not.toBeNull();
    expect(collected!.ids).toEqual(['a', 'b', 's']);
  });

  it('engineBody renders a mixed seed+operator batch as one turn: seed passes through raw, operator becomes a `<user>` chunk, seed ordered first', () => {
    const seed = seedRow('s1', new Date('2026-07-02T12:00:00Z'));
    seed.body = '<system_notice>hi</system_notice>';
    const operator = operatorRow('op', new Date('2026-07-02T12:00:01Z'));
    const { manager } = makeManager([seed, operator]);
    const m = manager as unknown as {
      pendingRowToChunk: (p: TurnEnvelope) => TurnChunk;
      engineBody: (s: TurnEnvelope) => string;
    };

    const chunks = [m.pendingRowToChunk(seed), m.pendingRowToChunk(operator)];
    const combined: TurnEnvelope = { ...seed, chunks };

    const body = m.engineBody(combined);

    expect(body).toContain(seed.body);
    expect(body).not.toContain('<passthrough');
    expect(body).toContain('<user name="Dennis"');
    expect(body.indexOf(seed.body)).toBeLessThan(body.indexOf('<user name="Dennis"'));
  });

  it('stampBatchOnRegistered stamps a plain row immediately but defers a card-bearing seed row', () => {
    const t0 = new Date('2026-07-02T12:00:00Z');
    const t1 = new Date('2026-07-02T12:00:01Z');
    const seed = seedRow('card1', t0); // deliveredQuestionIds set → isSeedCardDelivery === true
    const operator = operatorRow('op1', t1);
    const { manager, stimulusStore } = makeManager([seed, operator]);

    (
      manager as unknown as {
        stampBatchOnRegistered: (p: TurnEnvelope[]) => void;
      }
    ).stampBatchOnRegistered([seed, operator]);

    expect(stimulusStore.markChatDelivered).toHaveBeenCalledWith('op1');
    expect(stimulusStore.markChatDelivered).not.toHaveBeenCalledWith('card1');
  });
});
