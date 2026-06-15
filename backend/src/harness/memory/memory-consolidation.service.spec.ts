import { RunnableLambda } from '@langchain/core/runnables';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fact } from '@workspace/shared/schemas';
import type { Repository } from 'typeorm';
import type { TenantCredentialService } from '../llm-keys/tenant-credential.service';
import type { ChatModelFactory } from '../llm/chat-model.factory';
import type { MemoryMetricsService } from './memory-metrics.service';
import { MemoryConsolidationService } from './memory-consolidation.service';
import type { MemoryWriteService } from './memory-write.service';
import type { SemanticMemory } from './semantic-memory';

/**
 * Unit pins for Phase 7 — MemoryConsolidationService:
 *
 *  1. Per-scope grouping: tenant with two scopes → both scopes processed.
 *  2. Merge: auto-applied — survivor text updated, dropped ids soft-deleted.
 *  3. Drop-stale: auto-applied — soft-delete called with correct (id, scope, teamId).
 *  4. Contradiction: FLAGGED only — no write calls for contradictions.
 *  5. One scope's failure doesn't abort the rest of the run.
 *  6. Writes go through withLock (both merge and drop paths).
 *  7. Re-entrancy guard: a second overlapping tick is silently skipped.
 *  8. Runs inside CredentialContext.run (mock verifies the scope).
 */

// ── Minimal fake Fact ─────────────────────────────────────────────────────────
const makeFact = (id: number, fact: string, scope: string): Fact => ({
  id,
  fact,
  scope,
  team_id: 'T001',
  asserted_by: null,
  source_surface: null,
  confidence: 1.0,
  embed_model: null,
  deleted_at: null,
  created_at: new Date(),
  updated_at: new Date(),
  embedding: '',
});

// ── Mock builders ─────────────────────────────────────────────────────────────

/** Build a fake SemanticMemory with spy methods. */
function makeSemantic(factsByScope: Record<string, Fact[]>) {
  return {
    listLiveByScope: vi.fn((scope: string) =>
      Promise.resolve(factsByScope[scope] ?? []),
    ),
    mergeFacts: vi.fn(() => Promise.resolve()),
    forgetByIdInScope: vi.fn(() => Promise.resolve()),
  } as unknown as SemanticMemory;
}

/**
 * Build a fake MemoryWriteService whose `withLock` immediately executes the callback
 * (no actual mutex — unit tests are single-threaded). Records calls.
 */
function makeWrite() {
  const withLock = vi.fn((fn: () => Promise<void>) => fn());
  return { withLock } as unknown as MemoryWriteService;
}

function makeMetrics() {
  return {
    recordConsolidation: vi.fn(),
  } as unknown as MemoryMetricsService;
}

/** Build a ChatModelFactory stub that returns a chain always emitting `result`. */
function makeModels(result: {
  reasoning: string;
  merge: Array<{
    survivorId: number;
    droppedIds: number[];
    canonicalText: string;
  }>;
  dropStale: Array<{ id: number; reason: string }>;
  flagContradiction: Array<{ idA: number; idB: number; reason: string }>;
}) {
  const chain = RunnableLambda.from(() => Promise.resolve(result));
  const buildModel = vi.fn(() => ({
    withStructuredOutput: vi.fn(() => chain),
  }));
  return { buildModel } as unknown as ChatModelFactory;
}

/** Build a TenantCredentialService stub that resolves empty keys for any team. */
function makeTenantCreds() {
  return {
    resolve: vi.fn(() => Promise.resolve({ anthropic: 'k', openai: 'k' })),
  } as unknown as TenantCredentialService;
}

/** Build a CredentialContext stub whose run() executes the callback with a recorded teamId. */
function makeCredCtx() {
  const captured: string[] = [];
  return {
    captured,
    run: vi.fn(
      (creds: { teamId: string; keys: object }, fn: () => Promise<void>) => {
        captured.push(creds.teamId);
        return fn();
      },
    ),
  };
}

/**
 * Build a Repository<Fact> stub that supports the TypeORM QueryBuilder API used by
 * MemoryConsolidationService. Each call to `createQueryBuilder` consumes the next result
 * from `qbResults` and returns a chainable QB object whose `getRawMany` resolves it.
 */
function makeFactRepo(qbResults: unknown[][]) {
  let call = 0;
  const createQueryBuilder = vi.fn((_alias?: string) => {
    const result = qbResults[call++] ?? [];
    return {
      select: vi.fn().mockReturnThis(),
      addSelect: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      having: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      getRawMany: vi.fn(() => Promise.resolve(result)),
    };
  });
  return { createQueryBuilder } as unknown as Repository<Fact>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MemoryConsolidationService', () => {
  const TEAM_ID = 'T001';
  const SCOPE_A = 'project:alpha';
  const SCOPE_B = 'team:T001';

  function build({
    factsByScope = {},
    llmResult = {
      reasoning: 'nothing to do',
      merge: [] as Array<{
        survivorId: number;
        droppedIds: number[];
        canonicalText: string;
      }>,
      dropStale: [] as Array<{ id: number; reason: string }>,
      flagContradiction: [] as Array<{
        idA: number;
        idB: number;
        reason: string;
      }>,
    },
    tenantRows = [{ team_id: TEAM_ID }] as Array<{ team_id: string }>,
    // scope → fact_count for the per-tenant scope query
    scopeRows = [] as Array<{ scope: string }>,
  } = {}) {
    const semantic = makeSemantic(factsByScope);
    const write = makeWrite();
    const metrics = makeMetrics();
    const models = makeModels(llmResult);
    const tenantCreds = makeTenantCreds();
    const credCtx = makeCredCtx();
    // First query = tenants, subsequent = scopes per tenant
    const factRepo = makeFactRepo([tenantRows, scopeRows]);

    const svc = new MemoryConsolidationService(
      semantic,
      write,
      metrics,
      models,
      tenantCreds,
      credCtx as any,
      factRepo,
    );

    return {
      svc,
      semantic,
      write,
      metrics,
      models,
      tenantCreds,
      credCtx,
      factRepo,
    };
  }

  describe('per-scope grouping', () => {
    it('processes both scopes when a tenant has two eligible scopes', async () => {
      const facts = [
        makeFact(1, 'Fact one', SCOPE_A),
        makeFact(2, 'Fact two', SCOPE_A),
        makeFact(3, 'Fact three', SCOPE_A),
        makeFact(4, 'Team fact', SCOPE_B),
        makeFact(5, 'Team fact 2', SCOPE_B),
        makeFact(6, 'Team fact 3', SCOPE_B),
      ];
      const { svc, semantic } = build({
        factsByScope: {
          [SCOPE_A]: facts.slice(0, 3),
          [SCOPE_B]: facts.slice(3),
        },
        scopeRows: [{ scope: SCOPE_A }, { scope: SCOPE_B }],
      });

      await svc.consolidate();

      expect(semantic.listLiveByScope).toHaveBeenCalledWith(
        SCOPE_A,
        TEAM_ID,
        expect.any(Number),
      );
      expect(semantic.listLiveByScope).toHaveBeenCalledWith(
        SCOPE_B,
        TEAM_ID,
        expect.any(Number),
      );
    });
  });

  describe('merge (auto-apply)', () => {
    it('calls mergeFacts and routes through withLock', async () => {
      const facts = [
        makeFact(10, 'Alex owns auth', SCOPE_A),
        makeFact(11, 'Alex is responsible for auth endpoints', SCOPE_A),
        makeFact(12, 'PRs target develop', SCOPE_A),
      ];
      const { svc, semantic, write, metrics } = build({
        factsByScope: { [SCOPE_A]: facts },
        llmResult: {
          reasoning: 'facts 10+11 are duplicates',
          merge: [
            {
              survivorId: 10,
              droppedIds: [11],
              canonicalText: 'Alex owns the auth endpoints',
            },
          ],
          dropStale: [],
          flagContradiction: [],
        },
        scopeRows: [{ scope: SCOPE_A }],
      });

      await svc.consolidate();

      expect(write.withLock).toHaveBeenCalled();
      expect(semantic.mergeFacts).toHaveBeenCalledWith(
        10,
        [11],
        'Alex owns the auth endpoints',
        TEAM_ID,
      );
      expect(semantic.forgetByIdInScope).not.toHaveBeenCalled();
      const tally = (metrics.recordConsolidation as ReturnType<typeof vi.fn>)
        .mock.calls[0][0];
      expect(tally.merged).toBe(1);
      expect(tally.dropped).toBe(0);
    });

    it('skips a merge where survivorId is in droppedIds (model hallucination guard)', async () => {
      const facts = [
        makeFact(1, 'a', SCOPE_A),
        makeFact(2, 'b', SCOPE_A),
        makeFact(3, 'c', SCOPE_A),
      ];
      const { svc, semantic } = build({
        factsByScope: { [SCOPE_A]: facts },
        llmResult: {
          reasoning: 'bad merge',
          // survivor also listed in dropped — should be filtered
          merge: [{ survivorId: 1, droppedIds: [1, 2], canonicalText: 'a+b' }],
          dropStale: [],
          flagContradiction: [],
        },
        scopeRows: [{ scope: SCOPE_A }],
      });

      await svc.consolidate();

      // Only id=2 should be dropped (1 was stripped as the survivor)
      expect(semantic.mergeFacts).toHaveBeenCalledWith(1, [2], 'a+b', TEAM_ID);
    });
  });

  describe('drop-stale (auto-apply)', () => {
    it('calls forgetByIdInScope and routes through withLock', async () => {
      const facts = [
        makeFact(20, 'Standup is today at 3pm', SCOPE_A),
        makeFact(21, 'Backend uses Postgres', SCOPE_A),
        makeFact(22, 'PRs target develop', SCOPE_A),
      ];
      const { svc, semantic, write, metrics } = build({
        factsByScope: { [SCOPE_A]: facts },
        llmResult: {
          reasoning: 'fact 20 is time-bounded',
          merge: [],
          dropStale: [{ id: 20, reason: 'time-bounded standup' }],
          flagContradiction: [],
        },
        scopeRows: [{ scope: SCOPE_A }],
      });

      await svc.consolidate();

      expect(write.withLock).toHaveBeenCalled();
      expect(semantic.forgetByIdInScope).toHaveBeenCalledWith(
        20,
        SCOPE_A,
        TEAM_ID,
      );
      const tally = (metrics.recordConsolidation as ReturnType<typeof vi.fn>)
        .mock.calls[0][0];
      expect(tally.dropped).toBe(1);
      expect(tally.merged).toBe(0);
    });
  });

  describe('flag-contradiction (never auto-resolve)', () => {
    it('does NOT write anything for contradictions — only records metrics and logs', async () => {
      const facts = [
        makeFact(30, 'Backend uses Postgres', SCOPE_A),
        makeFact(31, 'Backend uses MySQL', SCOPE_A),
        makeFact(32, 'PRs go to develop', SCOPE_A),
      ];
      const { svc, semantic, write, metrics } = build({
        factsByScope: { [SCOPE_A]: facts },
        llmResult: {
          reasoning: '30 and 31 contradict',
          merge: [],
          dropStale: [],
          flagContradiction: [
            { idA: 30, idB: 31, reason: 'DB engine conflict' },
          ],
        },
        scopeRows: [{ scope: SCOPE_A }],
      });

      await svc.consolidate();

      // No writes for contradictions
      expect(semantic.mergeFacts).not.toHaveBeenCalled();
      expect(semantic.forgetByIdInScope).not.toHaveBeenCalled();
      expect(write.withLock).not.toHaveBeenCalled();

      const tally = (metrics.recordConsolidation as ReturnType<typeof vi.fn>)
        .mock.calls[0][0];
      expect(tally.contradictionsFlagged).toBe(1);
      expect(tally.merged).toBe(0);
      expect(tally.dropped).toBe(0);
    });
  });

  describe('error isolation', () => {
    it("a failure in one scope does not abort the run — other scopes' metrics are still recorded", async () => {
      const scopeA_facts = [
        makeFact(40, 'a', SCOPE_A),
        makeFact(41, 'b', SCOPE_A),
        makeFact(42, 'c', SCOPE_A),
      ];
      const scopeB_facts = [
        makeFact(50, 'd', SCOPE_B),
        makeFact(51, 'e', SCOPE_B),
        makeFact(52, 'f', SCOPE_B),
      ];

      const semantic = makeSemantic({
        [SCOPE_A]: scopeA_facts,
        [SCOPE_B]: scopeB_facts,
      });
      // Throw on the first call (scope A), succeed on scope B
      let calls = 0;
      (semantic.listLiveByScope as ReturnType<typeof vi.fn>).mockImplementation(
        (scope: string) => {
          calls++;
          if (calls === 1) return Promise.reject(new Error('db down'));
          return Promise.resolve(scope === SCOPE_B ? scopeB_facts : []);
        },
      );

      const write = makeWrite();
      const metrics = makeMetrics();
      const models = makeModels({
        reasoning: 'ok',
        merge: [],
        dropStale: [],
        flagContradiction: [],
      });
      const tenantCreds = makeTenantCreds();
      const credCtx = makeCredCtx();
      const factRepo = makeFactRepo([
        [{ team_id: TEAM_ID }],
        [{ scope: SCOPE_A }, { scope: SCOPE_B }],
      ]);

      const svc = new MemoryConsolidationService(
        semantic,
        write,
        metrics,
        models,
        tenantCreds,
        credCtx as any,
        factRepo,
      );

      // Should NOT throw even though scope A fails
      await expect(svc.consolidate()).resolves.toBeUndefined();

      // Both scopes should have recorded metrics (scope A records the error)
      expect(metrics.recordConsolidation).toHaveBeenCalledTimes(2);
      const scopeACall = (
        metrics.recordConsolidation as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];
      expect(scopeACall.errors).toBe(1);
      const scopeBCall = (
        metrics.recordConsolidation as ReturnType<typeof vi.fn>
      ).mock.calls[1][0];
      expect(scopeBCall.errors).toBe(0);
    });
  });

  describe('writes go through withLock', () => {
    it('both merge and drop paths call withLock', async () => {
      const facts = [
        makeFact(60, 'a', SCOPE_A),
        makeFact(61, 'b', SCOPE_A),
        makeFact(62, 'old standup time', SCOPE_A),
      ];
      const { svc, write } = build({
        factsByScope: { [SCOPE_A]: facts },
        llmResult: {
          reasoning: 'merge 60+61 and drop 62',
          merge: [
            { survivorId: 60, droppedIds: [61], canonicalText: 'merged' },
          ],
          dropStale: [{ id: 62, reason: 'stale' }],
          flagContradiction: [],
        },
        scopeRows: [{ scope: SCOPE_A }],
      });

      await svc.consolidate();

      // withLock called once for the merge and once for the drop
      expect(write.withLock).toHaveBeenCalledTimes(2);
    });
  });

  describe('re-entrancy guard', () => {
    it('skips a second overlapping tick', async () => {
      // Use a repo whose first QB.getRawMany never resolves to simulate a long-running first tick.
      let resolveFirst!: (rows: Array<{ team_id: string }>) => void;
      const firstQuery = new Promise<Array<{ team_id: string }>>((res) => {
        resolveFirst = res;
      });
      let qbCallIndex = 0;
      const createQueryBuilder = vi.fn(() => {
        const callIdx = qbCallIndex++;
        return {
          select: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          andWhere: vi.fn().mockReturnThis(),
          groupBy: vi.fn().mockReturnThis(),
          having: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          // First call (tenants) blocks until resolveFirst; subsequent calls (scopes) return []
          getRawMany: vi.fn(() =>
            callIdx === 0 ? firstQuery : Promise.resolve([]),
          ),
        };
      });
      const factRepo = { createQueryBuilder } as unknown as Repository<Fact>;

      const semantic = makeSemantic({});
      const write = makeWrite();
      const metrics = makeMetrics();
      const models = makeModels({
        reasoning: 'nothing',
        merge: [],
        dropStale: [],
        flagContradiction: [],
      });
      const tenantCreds = makeTenantCreds();
      const credCtx = makeCredCtx();

      const svc = new MemoryConsolidationService(
        semantic,
        write,
        metrics,
        models,
        tenantCreds,
        credCtx as any,
        factRepo,
      );

      // Start first tick (doesn't complete yet — blocked on tenant QB query)
      const first = svc.consolidate();
      // Immediately fire a second tick
      const second = svc.consolidate();

      // Second tick resolves instantly (skipped because this.running = true)
      await second;
      // Only the first tick's tenant QB has been initiated at this point
      expect(createQueryBuilder).toHaveBeenCalledTimes(1);

      // Unblock the first tick (tenant query resolves → runTenant → empty scopes → done)
      resolveFirst([{ team_id: TEAM_ID }]);
      await first;
    });
  });

  describe('CredentialContext wiring', () => {
    it('runs each tenant inside CredentialContext.run with the correct teamId', async () => {
      const TEAM_A = 'T_A';
      const TEAM_B = 'T_B';

      const factsByScope: Record<string, Fact[]> = {};
      const semantic = makeSemantic(factsByScope);
      const write = makeWrite();
      const metrics = makeMetrics();
      const models = makeModels({
        reasoning: 'nothing',
        merge: [],
        dropStale: [],
        flagContradiction: [],
      });
      const tenantCreds = {
        resolve: vi.fn(() => Promise.resolve({ anthropic: 'k', openai: 'k' })),
      } as unknown as TenantCredentialService;
      const credCtx = makeCredCtx();

      // First query → two tenants; subsequent queries → no scopes
      const factRepo = makeFactRepo([
        [{ team_id: TEAM_A }, { team_id: TEAM_B }],
        [], // no scopes for TEAM_A
        [], // no scopes for TEAM_B
      ]);

      const svc = new MemoryConsolidationService(
        semantic,
        write,
        metrics,
        models,
        tenantCreds,
        credCtx as any,
        factRepo,
      );

      await svc.consolidate();

      // CredentialContext.run must have been called once per tenant
      expect(credCtx.run).toHaveBeenCalledTimes(2);
      expect(credCtx.captured).toContain(TEAM_A);
      expect(credCtx.captured).toContain(TEAM_B);
    });
  });
});
