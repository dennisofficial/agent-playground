import { RunnableLambda } from '@langchain/core/runnables';
import type { Identity } from '../domain/identity';
import type { EmployeeRegistry } from '../employees/employee.registry';
import type { EmployeeDefinition } from '../employees/employee.types';
import type { ChatModelFactory } from '../llm/chat-model.factory';
import type { MemoryMetricsService } from './memory-metrics.service';
import type { MemoryWriteService } from './memory-write.service';
import { ReconcileService } from './reconcile.service';
import type { SemanticMemory } from './semantic-memory';
import type { NewTask, Task, TaskStore } from './task-store';

/**
 * Pins the task-reconcile OWNERSHIP rules — the fix for the reminder echo-loop, where six bots
 * watching one "I'll call open_pr" each minted a copy of the same reminder (the (project, owner,
 * norm) index can't dedup paraphrases, let alone across observers):
 *  - a non-scrum bot's pass may only ADD tasks it itself owns; teammate-owned proposals are
 *    SKIPPED (never rewritten onto its own plate);
 *  - the scrum master keeps cross-owner assignment, and reconciles against the TEAM's open
 *    plates (not just his own) so he sees what already exists.
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

const bot = (id: string, name: string, scrumMaster = false): EmployeeDefinition =>
  ({
    id,
    name,
    role: scrumMaster ? 'scrum master' : 'engineer',
    engine: 'claude',
    roleContext: 'ctx',
    ...(scrumMaster ? { scrumMaster: true } : {}),
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
    list: () => [bot('alex', 'Alex'), bot('nora', 'Nora'), bot('riley', 'Riley'), bot('sam', 'Sam', true)],
  } as unknown as EmployeeRegistry;
  const service = new ReconcileService(
    {} as SemanticMemory,
    tasks,
    {} as MemoryWriteService,
    { recordTaskReconcile: () => {}, recordMemoryReconcile: () => {} } as unknown as MemoryMetricsService,
    employees,
    models,
  );
  return { service, added, completed, listed };
}

describe('ReconcileService.reconcileTasks ownership', () => {
  it("a non-scrum bot SKIPS a teammate-owned capture — Sam's \"I'll open the PR\" never lands on Alex's plate", async () => {
    const { service, added } = build({
      result: { add: [{ description: 'Call open_pr once Dennis re-registers', owner: 'sam' }] },
    });
    await service.reconcileTasks(bot('alex', 'Alex'), "Sam: I'll call open_pr once Dennis re-registers.", CHANNEL_ID);
    expect(added).toEqual([]); // skipped outright, NOT rewritten onto alex's plate
  });

  it('a non-scrum bot captures its OWN commitment (including a handoff addressed to it) exactly once', async () => {
    const { service, added } = build({
      result: { add: [{ description: 'Update NORA.md and publish', owner: 'nora' }] },
    });
    await service.reconcileTasks(bot('nora', 'Nora'), 'Dennis: Nora, update NORA.md and publish.', CHANNEL_ID);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ owner: 'nora', createdBy: 'nora' });
  });

  it('an invented owner id falls back to the committing bot (self) and is captured', async () => {
    const { service, added } = build({
      result: { add: [{ description: 'Wire the hooks', owner: '<unknown>' }] },
    });
    await service.reconcileTasks(bot('riley', 'Riley'), "Riley: I'll wire the hooks after lunch.", CHANNEL_ID);
    expect(added).toHaveLength(1);
    expect(added[0].owner).toBe('riley');
  });

  it('the scrum master assigns cross-owner and reconciles against the TEAM-wide open plates', async () => {
    const teamPlate = [task(31, 'Call open_pr', 'sam'), task(53, 'call open_pr again', 'nora')];
    const { service, added, completed, listed } = build({
      result: {
        add: [{ description: 'Riley wires the UI', owner: 'riley' }],
        complete: [{ id: 53 }], // a teammate's dupe, shown team-wide → clearable in this pass
      },
      team: teamPlate,
    });
    await service.reconcileTasks(bot('sam', 'Sam', true), 'Sam: Riley, you wire the UI. Clearing the dupe.', CHANNEL_ID);
    expect(listed).toEqual(['team']); // openTasks, not remindersForBot
    expect(added).toHaveLength(1);
    expect(added[0].owner).toBe('riley');
    expect(completed).toEqual([53]);
  });

  it("a non-scrum bot cannot complete a task that wasn't on its shown plate", async () => {
    const { service, completed } = build({
      result: { complete: [{ id: 31 }] }, // not in `mine` → not shown → must not complete
      mine: [],
    });
    await service.reconcileTasks(bot('alex', 'Alex'), 'Alex: that PR task is done.', CHANNEL_ID);
    expect(completed).toEqual([]);
  });
});
