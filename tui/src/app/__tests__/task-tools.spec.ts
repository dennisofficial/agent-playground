import { describe, expect, it } from 'bun:test';
import { NO_TASKS, type TaskView } from '../../domain/tasks.js';
import { EAtlasTool, EToolTier } from '../../domain/tool-surface.js';
import {
  EPhaseKind,
  ETaskStatus,
  EThreadRole,
} from '../../generated/prisma/enums.js';
import type { Job, Thread } from '../../generated/prisma/client.js';
import { TaskService } from '../task.service.js';
import { fakeTaskRepository, throwingTaskRepository } from './tasks.fixture.js';
import { atlasToolsFor } from '../tools/registry.js';
import type { AtlasTool, ToolActions, ToolContext } from '../tools/tool.js';

/**
 * The three task tools, end to end over an in-memory list.
 *
 * The claim being tested everywhere below is the one the whole ticket rests on: **these tools never
 * throw.** A task list that can fail a turn is worse than one that is briefly wrong, so every bad
 * call — a wrong number, a malformed argument, a store that is on fire — has to come back as a
 * sentence the agent can read.
 */

function context(tier: EToolTier = EToolTier.thread): ToolContext {
  return {
    job: { id: 'job-1' } as unknown as Job,
    thread: { id: 'thread-1', role: EThreadRole.builder } as unknown as Thread,
    phase: EPhaseKind.build,
    cwd: '/tmp/atlas',
    tier,
  };
}

function actions(taskService?: TaskService): ToolActions {
  return {
    advanceThread: async () => 'advanced',
    advancePhase: async () => 'proposed',
    openThread: async () => 'opened',
    completeThread: async () => 'completed',
    rotate: async () => 'rotated',
    ...(taskService ? { tasks: taskService } : {}),
  };
}

function toolsFor(args: {
  tier?: EToolTier;
  taskService?: TaskService;
}): readonly AtlasTool[] {
  return atlasToolsFor({
    ctx: context(args.tier ?? EToolTier.thread),
    actions: actions(args.taskService),
  });
}

function named(tools: readonly AtlasTool[], name: EAtlasTool): AtlasTool {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`${name} is not in the surface`);
  return tool;
}

describe('the task tools are offered', () => {
  it('gives a thread create, update and list — and no get', () => {
    const names = toolsFor({ taskService: new TaskService(fakeTaskRepository()) }).map(
      (tool) => tool.name,
    );
    expect(names).toContain(EAtlasTool.task_create);
    expect(names).toContain(EAtlasTool.task_update);
    expect(names).toContain(EAtlasTool.task_list);
    // There is no `task_get`, in the enum or anywhere else — a checklist row has no detail view.
    expect(Object.values(EAtlasTool)).not.toContain('task_get');
  });

  /**
   * A teammate's progress shows as live activity in the thread that owns it. A second checklist
   * beside its parent's would be two plans for one piece of work.
   */
  it('gives a teammate none of them', () => {
    const names = toolsFor({
      tier: EToolTier.teammate,
      taskService: new TaskService(fakeTaskRepository()),
    }).map((tool) => tool.name);
    expect(names).not.toContain(EAtlasTool.task_create);
    expect(names).not.toContain(EAtlasTool.task_update);
    expect(names).not.toContain(EAtlasTool.task_list);
  });

  // Absence, not refusal: unwired, the tools are not in the list rather than present and failing.
  it('is absent entirely when nothing is wired to the list', () => {
    expect(toolsFor({}).map((tool) => tool.name)).not.toContain(EAtlasTool.task_create);
  });
});

describe('task_create', () => {
  it('appends the plan and shows the whole list back', async () => {
    const tools = toolsFor({ taskService: new TaskService(fakeTaskRepository()) });
    const reply = await named(tools, EAtlasTool.task_create).handler({
      tasks: ['read the code', 'write the code'],
    });

    expect(reply).toContain('Added 2 tasks.');
    expect(reply).toContain('#1 [pending] read the code');
    expect(reply).toContain('#2 [pending] write the code');
  });

  it('answers a malformed call instead of throwing it', async () => {
    const tools = toolsFor({ taskService: new TaskService(fakeTaskRepository()) });
    const create = named(tools, EAtlasTool.task_create);

    for (const bad of [{}, { tasks: 'a string' }, { tasks: [] }, { tasks: [7] }]) {
      const reply = await create.handler(bad);
      expect(reply).toContain('task_create takes `tasks`');
    }
  });
});

describe('task_update', () => {
  it('moves one task by its number and re-renders the list', async () => {
    const service = new TaskService(fakeTaskRepository());
    const tools = toolsFor({ taskService: service });
    await named(tools, EAtlasTool.task_create).handler({ tasks: ['one', 'two'] });

    const reply = await named(tools, EAtlasTool.task_update).handler({
      task: 2,
      status: ETaskStatus.in_progress,
    });
    expect(reply).toStartWith('#2 → in_progress');
    expect(reply).toContain('#2 [in_progress] two');
  });

  it('corrects the text when one is given', async () => {
    const tools = toolsFor({ taskService: new TaskService(fakeTaskRepository()) });
    await named(tools, EAtlasTool.task_create).handler({ tasks: ['one'] });

    const reply = await named(tools, EAtlasTool.task_update).handler({
      task: 1,
      status: ETaskStatus.completed,
      text: 'one, as it turned out',
    });
    expect(reply).toContain('#1 [completed] one, as it turned out');
  });

  // The sentence design ticket 07 §4 asks for by name.
  it('answers an unknown number instead of failing the turn', async () => {
    const tools = toolsFor({ taskService: new TaskService(fakeTaskRepository()) });
    expect(
      await named(tools, EAtlasTool.task_update).handler({
        task: 7,
        status: ETaskStatus.completed,
      }),
    ).toBe('No task #7 — call task_list.');
  });

  it('answers a malformed call instead of throwing it', async () => {
    const tools = toolsFor({ taskService: new TaskService(fakeTaskRepository()) });
    const update = named(tools, EAtlasTool.task_update);

    for (const bad of [{}, { task: 1 }, { task: 'two', status: 'completed' }, { task: 1, status: 'finished' }]) {
      expect(await update.handler(bad)).toContain('task_update takes `task`');
    }
  });

  it('retires a task without renumbering the ones around it', async () => {
    const tools = toolsFor({ taskService: new TaskService(fakeTaskRepository()) });
    await named(tools, EAtlasTool.task_create).handler({ tasks: ['one', 'two', 'three'] });
    await named(tools, EAtlasTool.task_update).handler({
      task: 2,
      status: ETaskStatus.deleted,
    });

    const list = await named(tools, EAtlasTool.task_list).handler({});
    expect(list).toContain('#1 [pending] one');
    expect(list).not.toContain('two');
    expect(list).toContain('#3 [pending] three');
  });
});

describe('task_list', () => {
  it('takes no arguments and cannot be called wrongly', async () => {
    const tools = toolsFor({ taskService: new TaskService(fakeTaskRepository()) });
    const list = named(tools, EAtlasTool.task_list);

    expect(list.shape).toEqual({});
    expect(await list.handler({ unexpected: true })).toBe(NO_TASKS);
  });

  it('shows a list this thread inherited rather than wrote', async () => {
    const inherited = fakeTaskRepository([
      { ordinal: 1, text: 'wire the composer', status: ETaskStatus.completed },
      { ordinal: 2, text: 'render the checklist', status: ETaskStatus.in_progress },
    ]);
    const tools = toolsFor({ taskService: new TaskService(inherited) });

    expect(await named(tools, EAtlasTool.task_list).handler({})).toContain(
      '#2 [in_progress] render the checklist',
    );
  });
});

describe('a store that fails', () => {
  // The strongest form of "never throws": the layer underneath is broken, and the turn survives.
  it('is a sentence, on every one of the three', async () => {
    const tools = toolsFor({ taskService: new TaskService(throwingTaskRepository()) });

    expect(await named(tools, EAtlasTool.task_create).handler({ tasks: ['one'] })).toContain(
      'did not take effect',
    );
    expect(
      await named(tools, EAtlasTool.task_update).handler({
        task: 1,
        status: ETaskStatus.completed,
      }),
    ).toContain('did not take effect');
    // A read that fails renders as "no tasks" rather than as an error: the list is a view, and an
    // empty one is the least misleading thing to say about a view that could not be built.
    expect(await named(tools, EAtlasTool.task_list).handler({})).toBe(NO_TASKS);
  });
});

describe('the hand-off section', () => {
  /**
   * The one non-cosmetic consequence of Atlas owning the list: it outlives the session, so a
   * successor inherits numbers it has never seen and must be told them.
   */
  it('carries the rendered list, and is empty when there is nothing to carry', async () => {
    const service = new TaskService(
      fakeTaskRepository([{ ordinal: 4, text: 'ship it', status: ETaskStatus.in_progress }]),
    );
    expect(await service.section('thread-1')).toContain('#4 [in_progress] ship it');
    expect(await new TaskService(fakeTaskRepository()).section('thread-1')).toBe('');
  });
});
