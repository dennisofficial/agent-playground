import { describe, expect, it, vi } from 'vitest';
import type { ChatStimulus } from '../domain';
import type { EngineRunnerPort } from '../engine/engine.types';
import type { LeaderElectionService } from '../cluster';
import type { TurnRegistry } from '../sandbox/turn-registry.service';
import { AgentSessionManager } from './agent-session-manager.service';

/** Shape of `collectPendingForTurn`'s return — mirrors the private method under test. */
interface CollectedLike {
  pending: ChatStimulus[];
  userChunks: unknown[];
  ids: string[];
  wake: boolean;
}

const JOB_ID = 'th-collect-001';
const ORG_ID = 'T-COLLECT';
const REPO_ID = 'repo-collect';

/** A pending chat stimulus, ChatStimulus-shaped, as `stimulusStore.eligiblePendingChat` would resolve it. */
function pendingRow(
  id: string,
  priority: ChatStimulus['priority'],
  receivedAt: Date,
): ChatStimulus {
  return {
    id,
    orgId: ORG_ID,
    repoId: REPO_ID,
    kind: 'chat',
    trust: 'trusted',
    jobId: JOB_ID,
    body: `body-${id}`,
    author: { id: 'U1', displayName: 'Dennis' },
    replyRoute: { surfaceId: 'web', jobRef: JOB_ID },
    receivedAt,
    ...(priority !== undefined ? { priority } : {}),
  };
}

/** A manager wired with only the deps `collectPendingForTurn` touches; everything else inert. */
function makeManager(pending: ChatStimulus[]) {
  const stimulusStore = {
    eligiblePendingChat: vi.fn().mockResolvedValue(pending),
  };
  const turnRegistry = {} as unknown as TurnRegistry;
  const engineRunner = { run: vi.fn() } as unknown as EngineRunnerPort;
  const election = { getState: () => 'follower' } as unknown as LeaderElectionService;
  const inert = {} as never;
  return new AgentSessionManager(
    inert, inert, inert, inert, inert, // store, driverStore, memory, approvals, lifecycle (5)
    engineRunner, // engineRunner (6)
    turnRegistry, // turnRegistry (7)
    inert, inert, inert, // planReview, dispatcher, surface (10)
    inert, // sandboxRows (11)
    inert, // stimulusRows (12)
    stimulusStore as never, // stimulusStore (13)
    inert, inert, inert, inert, inert, inert, inert, inert, // turnHarness…creds (21)
    inert, // mcp (McpResolver, 22)
    election, // election (23)
    inert, inert, inert, inert, // turnRecovery…git (27)
    { generate: () => 'SYSTEM' } as never, // prompts (29, PromptService)
    { register: () => undefined } as never, // threadInput (ThreadInputService)
    { judge: async () => undefined } as never, // liveVerificationJudge (LIVE_VERIFICATION_JUDGE)
    { getResetAt: () => undefined } as never, // usage (OauthUsageService)
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
      manager as unknown as { collectPendingForTurn: (jobId: string) => Promise<CollectedLike | null> }
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
      manager as unknown as { collectPendingForTurn: (jobId: string) => Promise<CollectedLike | null> }
    ).collectPendingForTurn(JOB_ID);

    expect(collected).not.toBeNull();
    expect(collected!.userChunks).toHaveLength(1);
    expect(collected!.wake).toBe(false);
  });

  it('no pending rows: returns null', async () => {
    const manager = makeManager([]);

    const collected = await (
      manager as unknown as { collectPendingForTurn: (jobId: string) => Promise<CollectedLike | null> }
    ).collectPendingForTurn(JOB_ID);

    expect(collected).toBeNull();
  });
});
