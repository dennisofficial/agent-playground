import type { Message, TurnEnvelope } from '@shared/domain';
import type { EngineRunnerPort } from '@shared/engine/engine.types';
import { describe, expect, it, vi } from 'vitest';
import type { LeaderElectionService } from '../cluster';
import type { TurnRegistry } from '../sandbox/turn-registry.service';
import { SYSTEM_SEED_AUTHOR } from '../surface';
import { AgentSessionManager } from './agent-session-manager.service';

/** Shape of `collectPendingForTurn`'s return — mirrors the private method under test. */
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

/** A pending chat `TurnEnvelope`, as `stimulusStore.eligiblePendingChat` would resolve it. */
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

/** A system-seed chat `TurnEnvelope` (harness-authored), as a delivery seed would resolve it. */
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

/** An operator-authored chat `TurnEnvelope` (a real human message). */
function operatorRow(id: string, receivedAt: Date): TurnEnvelope {
  return pendingRow(id, undefined as unknown as TurnEnvelope['priority'], receivedAt);
}

/** A manager wired with only the deps `collectPendingForTurn` touches; everything else inert. */
function makeManager(pending: TurnEnvelope[]) {
  const stimulusStore = {
    eligiblePendingChat: vi.fn().mockResolvedValue(pending),
  };
  const turnRegistry = {} as unknown as TurnRegistry;
  const engineRunner = { run: vi.fn() } as unknown as EngineRunnerPort;
  const election = {
    getState: () => 'follower',
  } as unknown as LeaderElectionService;
  const inert = {} as never;
  return new AgentSessionManager(
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
    inert, // turnHarness…creds (20)
    inert, // mcp (McpResolver, 21)
    election, // election (22)
    inert,
    inert,
    inert,
    inert, // turnRecovery…git (27)
    { generate: () => 'SYSTEM' } as never, // prompts (28, PromptService)
    { register: () => undefined } as never, // threadInput (ThreadInputService)
    { getResetAt: () => undefined } as never, // usage (OauthUsageService)
    inert, // selfSufficiency
  );
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
    const manager = makeManager(pending);

    const collected = await (
      manager as unknown as {
        collectPendingForTurn: (jobId: string) => Promise<CollectedLike | null>;
      }
    ).collectPendingForTurn(JOB_ID);

    expect(collected).not.toBeNull();
    // The ride-along `later` message IS included in the coalesced compose set, in chronological order.
    expect(collected!.userChunks).toHaveLength(3);
    expect(collected!.ids).toEqual(['a', 'b', 'c']);
    // `a` (now) and `c` (queue) are wake-eligible.
    expect(collected!.wake).toBe(true);
  });

  it('a thread whose ONLY pending row is `later`: composes it (ride-along) but does not wake', async () => {
    const pending = [pendingRow('only-later', 'later', new Date('2026-07-02T12:00:00Z'))];
    const manager = makeManager(pending);

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
    const manager = makeManager([]);

    const collected = await (
      manager as unknown as {
        collectPendingForTurn: (jobId: string) => Promise<CollectedLike | null>;
      }
    ).collectPendingForTurn(JOB_ID);

    expect(collected).toBeNull();
  });
});

describe('AgentSessionManager.collectPendingForTurn (seed vs. operator partition)', () => {
  it('a seed HEAD delivers SOLO, leaving a trailing operator row pending', async () => {
    const t0 = new Date('2026-07-02T12:00:00Z');
    const t1 = new Date('2026-07-02T12:00:01Z');
    const pending = [seedRow('s1', t0), operatorRow('op', t1)];
    const manager = makeManager(pending);

    const collected = await (
      manager as unknown as {
        collectPendingForTurn: (jobId: string) => Promise<CollectedLike | null>;
      }
    ).collectPendingForTurn(JOB_ID);

    expect(collected).not.toBeNull();
    expect(collected!.ids).toEqual(['s1']);
  });

  it('an operator HEAD coalesces the leading operator run but STOPS at a trailing seed', async () => {
    const t0 = new Date('2026-07-02T12:00:00Z');
    const t1 = new Date('2026-07-02T12:00:01Z');
    const t2 = new Date('2026-07-02T12:00:02Z');
    const pending = [operatorRow('a', t0), operatorRow('b', t1), seedRow('s', t2)];
    const manager = makeManager(pending);

    const collected = await (
      manager as unknown as {
        collectPendingForTurn: (jobId: string) => Promise<CollectedLike | null>;
      }
    ).collectPendingForTurn(JOB_ID);

    expect(collected).not.toBeNull();
    expect(collected!.ids).toEqual(['a', 'b']);
  });

  it('engineBody never wraps a seed body as a `<user>` chunk — it passes it through raw', () => {
    const seed = seedRow('s1', new Date('2026-07-02T12:00:00Z'));
    seed.body = '<system_notice>hi</system_notice>';
    const manager = makeManager([seed]);

    const body = (manager as unknown as { engineBody: (s: TurnEnvelope) => string }).engineBody(
      seed,
    );

    expect(body).toBe(seed.body);
    expect(body).not.toContain('<user');
  });
});
