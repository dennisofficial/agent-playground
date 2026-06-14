import { RunnableLambda } from '@langchain/core/runnables';
import { vi } from 'vitest';
import type { Identity } from '../domain/identity';
import type { EmployeeRegistry } from '../employees/employee.registry';
import type { EmployeeDefinition } from '../employees/employee.types';
import { EWorkerEngineName } from '../engines/worker-engine.port';
import type { ChatModelFactory } from '../llm/chat-model.factory';
import type { MemoryMetricsService } from './memory-metrics.service';
import { ReconcileService } from './reconcile.service';
import type { SemanticMemory } from './semantic-memory';
import type { NewTask, Task, TaskStore } from './task-store';
import type { MemoryWriteService } from './memory-write.service';

/**
 * Pins the task-reconcile OWNERSHIP rules — the fix for the reminder echo-loop, where six bots
 * watching one "I'll call open_pr" each minted a copy of the same reminder (the (project, owner,
 * norm) index can't dedup paraphrases, let alone across observers):
 *  - a non-lead bot's pass may only ADD tasks it itself owns; teammate-owned proposals are
 *    SKIPPED (never rewritten onto its own plate);
 *  - the team lead keeps cross-owner assignment, and reconciles against the TEAM's open
 *    plates (not just his own) so he sees what already exists.
 *
 * Also pins the Phase 2 memory-reconcile consent contract: reconcileMemory is READ-ONLY — it
 * surfaces suggestions but NEVER writes to the store. All writes go through the agent's own tools.
 */

const task = (id: number, description: string, owner: string): Task => ({
  id,
  project: 'local',
  description,
  owner,
  createdBy: owner,
  status: 'open',
  source: 'dev:root',
  createdAt: '',
  updatedAt: '',
});

const CHANNEL_ID: Identity = {
  selfAgent: 'alex',
  team: 'local',
  project: 'local',
  participants: ['dennis'],
  speaker: 'dennis',
  surface: 'dev:root',
  isChannel: true,
};

const bot = (id: string, name: string, teamLead = false): EmployeeDefinition =>
  ({
    id,
    name,
    role: teamLead ? 'team lead' : 'engineer',
    engine: EWorkerEngineName.CLAUDE,
    roleContext: 'ctx',
    ...(teamLead ? { teamLead: true } : {}),
  }) as unknown as EmployeeDefinition;

/** The scripted task-reconcile model output + a recording TaskStore double. */
function build(opts: {
  result: { add?: unknown[]; complete?: unknown[]; drop?: unknown[] };
  mine?: Task[];
  team?: Task[];
}) {
  const added: NewTask[] = [];
  const completed: number[] = [];
  const listed: string[] = [];
  const tasks = {
    remindersForBot: async () => {
      listed.push('mine');
      return opts.mine ?? [];
    },
    openTasks: async () => {
      listed.push('team');
      return opts.team ?? [];
    },
    addTask: async (t: NewTask) => {
      added.push(t);
      return task(99, t.description, t.owner);
    },
    completeTask: async (_team: string, _p: string, id: number) => {
      completed.push(id);
      return true;
    },
    dropTask: async () => true,
  } as unknown as TaskStore;
  const models = {
    buildExtractModel: () => ({
      withStructuredOutput: () =>
        RunnableLambda.from(async () => ({
          reasoning: 'scripted',
          add: [],
          complete: [],
          drop: [],
          ...opts.result,
        })),
    }),
  } as unknown as ChatModelFactory;
  const employees = {
    list: () => [
      bot('alex', 'Alex'),
      bot('nora', 'Nora'),
      bot('riley', 'Riley'),
      bot('sam', 'Sam', true),
    ],
  } as unknown as EmployeeRegistry;
  // Phase 2: ReconcileService no longer takes MemoryWriteService (removed — no writes in reconcile)
  const service = new ReconcileService(
    {} as SemanticMemory,
    tasks,
    {
      recordTaskReconcile: () => {},
      recordMemoryReconcile: () => {},
    } as unknown as MemoryMetricsService,
    employees,
    models,
  );
  return { service, added, completed, listed };
}

// ── Memory reconcile: scripted model output for suggestion tests ───────────────────────────────

type MemorySuggestion =
  | {
      op: 'add';
      kind: 'correction' | 'decision' | 'preference';
      fact: string;
      tier: string;
      authorId: string;
      supersedes?: number;
    }
  | {
      op: 'update';
      kind: 'correction' | 'decision' | 'preference';
      id: number;
      newFact: string;
    }
  | { op: 'delete'; id: number };

interface ScriptedMemoryResult {
  add?: Array<{
    kind: 'correction' | 'decision' | 'preference';
    fact: string;
    tier: string;
    authorId: string;
    supersedes?: number;
  }>;
  update?: Array<{
    kind: 'correction' | 'decision' | 'preference';
    id: number;
    newFact: string;
  }>;
  delete?: Array<{ id: number }>;
}

function buildMemory(scriptedResult: ScriptedMemoryResult) {
  const writes = {
    rememberDeduped: vi.fn(),
    withLock: vi.fn(),
  } as unknown as MemoryWriteService;

  const semantic = {
    recall: vi.fn().mockResolvedValue([]),
    updateFactById: vi.fn(),
    forgetFactById: vi.fn(),
  } as unknown as SemanticMemory;

  const models = {
    buildExtractModel: () => ({
      withStructuredOutput: () =>
        RunnableLambda.from(async () => ({
          reasoning: 'scripted',
          add: [],
          update: [],
          delete: [],
          ...scriptedResult,
        })),
    }),
  } as unknown as ChatModelFactory;

  const metrics = {
    recordTaskReconcile: vi.fn(),
    recordMemoryReconcile: vi.fn(),
  } as unknown as MemoryMetricsService;

  const employees = {
    list: () => [],
  } as unknown as EmployeeRegistry;

  const service = new ReconcileService(
    semantic,
    {} as TaskStore,
    metrics,
    employees,
    models,
  );

  return { service, semantic, writes, metrics };
}

// ── Task reconcile: ownership rules ───────────────────────────────────────────────────────────

describe('ReconcileService.reconcileTasks ownership', () => {
  it("a non-lead bot SKIPS a teammate-owned capture — Sam's \"I'll open the PR\" never lands on Alex's plate", async () => {
    const { service, added } = build({
      result: {
        add: [
          {
            description: 'Call open_pr once Dennis re-registers',
            owner: 'sam',
          },
        ],
      },
    });
    await service.reconcileTasks(
      bot('alex', 'Alex'),
      "Sam: I'll call open_pr once Dennis re-registers.",
      CHANNEL_ID,
    );
    expect(added).toEqual([]); // skipped outright, NOT rewritten onto alex's plate
  });

  it('a non-lead bot captures its OWN commitment (including a handoff addressed to it) exactly once', async () => {
    const { service, added } = build({
      result: {
        add: [{ description: 'Update NORA.md and publish', owner: 'nora' }],
      },
    });
    await service.reconcileTasks(
      bot('nora', 'Nora'),
      'Dennis: Nora, update NORA.md and publish.',
      CHANNEL_ID,
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ owner: 'nora', createdBy: 'nora' });
  });

  it('an invented owner id falls back to the committing bot (self) and is captured', async () => {
    const { service, added } = build({
      result: { add: [{ description: 'Wire the hooks', owner: '<unknown>' }] },
    });
    await service.reconcileTasks(
      bot('riley', 'Riley'),
      "Riley: I'll wire the hooks after lunch.",
      CHANNEL_ID,
    );
    expect(added).toHaveLength(1);
    expect(added[0].owner).toBe('riley');
  });

  it('the team lead assigns cross-owner and reconciles against the TEAM-wide open plates', async () => {
    const teamPlate = [
      task(31, 'Call open_pr', 'sam'),
      task(53, 'call open_pr again', 'nora'),
    ];
    const { service, added, completed, listed } = build({
      result: {
        add: [{ description: 'Riley wires the UI', owner: 'riley' }],
        complete: [{ id: 53 }], // a teammate's dupe, shown team-wide → clearable in this pass
      },
      team: teamPlate,
    });
    await service.reconcileTasks(
      bot('sam', 'Sam', true),
      'Sam: Riley, you wire the UI. Clearing the dupe.',
      CHANNEL_ID,
    );
    expect(listed).toEqual(['team']); // openTasks, not remindersForBot
    expect(added).toHaveLength(1);
    expect(added[0].owner).toBe('riley');
    expect(completed).toEqual([53]);
  });

  it("a non-lead bot cannot complete a task that wasn't on its shown plate", async () => {
    const { service, completed } = build({
      result: { complete: [{ id: 31 }] }, // not in `mine` → not shown → must not complete
      mine: [],
    });
    await service.reconcileTasks(
      bot('alex', 'Alex'),
      'Alex: that PR task is done.',
      CHANNEL_ID,
    );
    expect(completed).toEqual([]);
  });
});

// ── Memory reconcile: Phase 2 consent contract ────────────────────────────────────────────────

describe('ReconcileService.reconcileMemory (Phase 2 — suggestion-only, no writes)', () => {
  const BOT = bot('alex', 'Alex');

  it('returns empty string for off-class turns (greeting)', async () => {
    const { service } = buildMemory({ add: [], update: [], delete: [] });
    const result = await service.reconcileMemory(
      BOT,
      'Dennis: hey team!',
      CHANNEL_ID,
    );
    expect(result).toBe('');
  });

  it('returns empty string for a coding-style aside', async () => {
    const { service } = buildMemory({ add: [], update: [], delete: [] });
    const result = await service.reconcileMemory(
      BOT,
      'Dennis: use 2-space indentation in TypeScript files',
      CHANNEL_ID,
    );
    expect(result).toBe('');
  });

  it('returns empty string for an inferred preference (not explicitly stated)', async () => {
    const { service } = buildMemory({ add: [], update: [], delete: [] });
    const result = await service.reconcileMemory(
      BOT,
      'Dennis: I went ahead and pushed to develop again',
      CHANNEL_ID,
    );
    expect(result).toBe('');
  });

  it('returns a suggestion block for a stated preference, carrying kind = preference', async () => {
    const { service } = buildMemory({
      add: [
        {
          kind: 'preference',
          fact: 'Dennis wants PRs to target develop, not main',
          tier: 'team',
          authorId: 'dennis',
        },
      ],
    });
    const result = await service.reconcileMemory(
      BOT,
      'Dennis: I always want PRs to target develop, not main.',
      CHANNEL_ID,
    );
    expect(result).not.toBe('');
    expect(result).toContain('remember:');
    expect(result).toContain('preference');
    expect(result).toContain('Dennis wants PRs to target develop, not main');
  });

  it('returns a suggestion block for a named decision, carrying kind = decision', async () => {
    const { service } = buildMemory({
      add: [
        {
          kind: 'decision',
          fact: 'Backend standardizes on PostgreSQL',
          tier: 'project',
          authorId: 'dennis',
        },
      ],
    });
    const result = await service.reconcileMemory(
      BOT,
      "Dennis: We've decided to standardize on PostgreSQL.",
      CHANNEL_ID,
    );
    expect(result).not.toBe('');
    expect(result).toContain('remember:');
    expect(result).toContain('decision');
  });

  it('returns a suggestion block for an explicit correction, carrying kind = correction', async () => {
    const { service } = buildMemory({
      update: [{ kind: 'correction', id: 42, newFact: 'Backend uses MySQL' }],
    });
    const result = await service.reconcileMemory(
      BOT,
      'Dennis: Actually we switched to MySQL, not Postgres.',
      CHANNEL_ID,
    );
    expect(result).not.toBe('');
    expect(result).toContain('update_memory #42');
    expect(result).toContain('Backend uses MySQL');
    expect(result).toContain('correction');
  });

  it('renders a forget suggestion for a delete op', async () => {
    const { service } = buildMemory({
      delete: [{ id: 7 }],
    });
    const result = await service.reconcileMemory(
      BOT,
      'Dennis: That old fact is wrong now.',
      CHANNEL_ID,
    );
    expect(result).not.toBe('');
    expect(result).toContain('forget #7');
    expect(result).toContain('correction');
  });

  it('suggestion block carries kind for every line when multiple suggestions exist', async () => {
    const { service } = buildMemory({
      add: [
        {
          kind: 'preference',
          fact: 'Dennis wants PRs to target develop',
          tier: 'team',
          authorId: 'dennis',
        },
        {
          kind: 'decision',
          fact: 'Backend uses PostgreSQL',
          tier: 'project',
          authorId: 'dennis',
        },
      ],
    });
    const result = await service.reconcileMemory(BOT, 'transcript', CHANNEL_ID);
    expect(result).toContain('preference');
    expect(result).toContain('decision');
    const lines = result.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^• remember:/);
    expect(lines[1]).toMatch(/^• remember:/);
  });

  it('NEVER calls rememberDeduped, updateFactById, or forgetFactById regardless of suggestions', async () => {
    const { service, semantic, writes } = buildMemory({
      add: [
        {
          kind: 'preference',
          fact: 'Dennis prefers TypeScript strict mode',
          tier: 'team',
          authorId: 'dennis',
        },
      ],
      update: [{ kind: 'correction', id: 1, newFact: 'Updated fact' }],
      delete: [{ id: 2 }],
    });
    await service.reconcileMemory(
      BOT,
      'Dennis: Always use strict mode.',
      CHANNEL_ID,
    );
    expect(writes.rememberDeduped).not.toHaveBeenCalled();
    expect(writes.withLock).not.toHaveBeenCalled();
    expect(semantic.updateFactById).not.toHaveBeenCalled();
    expect(semantic.forgetFactById).not.toHaveBeenCalled();
  });

  it('records metrics with suggestion counts by class', async () => {
    const { service, metrics } = buildMemory({
      add: [
        {
          kind: 'preference',
          fact: 'Dennis prefers X',
          tier: 'team',
          authorId: 'dennis',
        },
        {
          kind: 'decision',
          fact: 'Backend uses Y',
          tier: 'project',
          authorId: 'dennis',
        },
      ],
      delete: [{ id: 5 }],
    });
    await service.reconcileMemory(BOT, 'some transcript', CHANNEL_ID);
    expect(metrics.recordMemoryReconcile).toHaveBeenCalledWith(
      'respond',
      expect.objectContaining({
        corrections: 1, // 1 delete (always correction)
        decisions: 1,
        preferences: 1,
      }),
    );
  });

  it('returns empty string and does not throw on reconcile error (fire-and-forget)', async () => {
    const semantic = {
      recall: vi.fn().mockRejectedValue(new Error('db down')),
    } as unknown as SemanticMemory;
    const models = {
      buildExtractModel: () => ({
        withStructuredOutput: () =>
          RunnableLambda.from(async () => {
            throw new Error('never');
          }),
      }),
    } as unknown as ChatModelFactory;
    const service = new ReconcileService(
      semantic,
      {} as TaskStore,
      {
        recordTaskReconcile: vi.fn(),
        recordMemoryReconcile: vi.fn(),
      } as unknown as MemoryMetricsService,
      { list: () => [] } as unknown as EmployeeRegistry,
      models,
    );
    await expect(
      service.reconcileMemory(BOT, 'Dennis: hello', CHANNEL_ID),
    ).resolves.toBe('');
  });
});
