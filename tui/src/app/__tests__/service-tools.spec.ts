import { describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { jobDir } from '../../domain/paths.js';
import { EAtlasTool, EToolTier } from '../../domain/tool-surface.js';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import type { Job, Thread } from '../../generated/prisma/client.js';
import { ServiceRegistryService } from '../service-registry.service.js';
import { atlasToolsFor } from '../tools/registry.js';
import type { AtlasTool, ToolActions, ToolContext } from '../tools/tool.js';

/**
 * The three service tools over the real registry.
 *
 * What is being tested is the SURFACE, not the spawn — which tools exist for whom, what the model
 * reads back when it gets a call wrong, and that the job and cwd it never passes are taken from the
 * context rather than from an argument it could get wrong.
 */

const JOB = `spec-service-tools-${randomUUID()}`;

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    job: { id: JOB } as unknown as Job,
    thread: { id: 'thread-1', role: EThreadRole.builder } as unknown as Thread,
    phase: EPhaseKind.build,
    cwd: tmpdir(),
    tier: EToolTier.thread,
    ...overrides,
  };
}

function actions(services?: ServiceRegistryService): ToolActions {
  return {
    advanceThread: async () => 'advanced',
    advancePhase: async () => 'proposed',
    openThread: async () => 'opened',
    completeThread: async () => 'completed',
    rotate: async () => 'rotated',
    ...(services ? { services } : {}),
  };
}

function toolsFor(args: {
  services?: ServiceRegistryService;
  ctx?: ToolContext;
}): readonly AtlasTool[] {
  return atlasToolsFor({
    ctx: args.ctx ?? context(),
    actions: actions(args.services),
  });
}

function named(tools: readonly AtlasTool[], name: EAtlasTool): AtlasTool {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`${name} is not in the surface`);
  return tool;
}

describe('the service tools in the surface', () => {
  /**
   * Absent, never present-and-throwing. The schema is the only rail the agent has, and a tool it can
   * see is a tool it will try — this is the same rule `tasks` and `shipping` follow, applied to
   * wiring rather than to phase.
   */
  it('does not exist at all when nothing wired a registry in', () => {
    const names = toolsFor({}).map((tool) => tool.name);
    expect(names).not.toContain(EAtlasTool.service_start);
    expect(names).not.toContain(EAtlasTool.service_stop);
    expect(names).not.toContain(EAtlasTool.service_list);
  });

  it('offers all three to a thread once one is', () => {
    const names = toolsFor({ services: new ServiceRegistryService() }).map(
      (tool) => tool.name,
    );
    expect(names).toContain(EAtlasTool.service_start);
    expect(names).toContain(EAtlasTool.service_stop);
    expect(names).toContain(EAtlasTool.service_list);
  });

  /**
   * A teammate is a subagent of one turn. A process that outlives the job's turns is not its to
   * start, and this is the assertion that would catch a `tiers` edit made without that argument.
   */
  it('offers none of them to a teammate', () => {
    const names = toolsFor({
      services: new ServiceRegistryService(),
      ctx: context({ tier: EToolTier.teammate }),
    }).map((tool) => tool.name);
    expect(names).not.toContain(EAtlasTool.service_start);
    expect(names).not.toContain(EAtlasTool.service_stop);
    expect(names).not.toContain(EAtlasTool.service_list);
  });

  /**
   * Ungated by phase, like `rotate`. `service_list` is not convenience: a thread opened after a seam
   * inherits the job's services and has no other way to learn their ids, so a phase that hid it
   * would strand them.
   */
  it('is offered in every phase, because services outlive the phase that started them', () => {
    for (const phase of [EPhaseKind.charting, EPhaseKind.planning, EPhaseKind.build]) {
      const names = toolsFor({
        services: new ServiceRegistryService(),
        ctx: context({ phase }),
      }).map((tool) => tool.name);
      expect(names).toContain(EAtlasTool.service_list);
    }
  });

  // Two ways to background a command is the one cost of adding a tool rather than replacing `Bash`,
  // so the choice has to be stated where the model reads it at the moment it makes it.
  it('tells the model in the description which work belongs here and which stays on Bash', () => {
    const start = named(
      toolsFor({ services: new ServiceRegistryService() }),
      EAtlasTool.service_start,
    );
    expect(start.description).toContain('Bash(run_in_background)');
    expect(start.description).toContain('after this turn ends');
  });
});

describe('service_list', () => {
  it('answers an empty job in prose rather than with an empty blob', async () => {
    const tools = toolsFor({ services: new ServiceRegistryService() });
    const reply = await named(tools, EAtlasTool.service_list).handler({});
    expect(reply).toContain('No services in this job');
  });

  /**
   * The slice's headline claim, at the surface: a service survives the thread that started it.
   *
   * Tool handlers are closures built once per thread-open, so anything a handler captured would be
   * thread-scoped — which is exactly why the registry is a job-keyed singleton and not a map inside
   * the closure. Two threads, two tool surfaces, one job, and the second must see the first's work
   * and be able to name it. Without that, a thread arriving after a seam inherits services it cannot
   * list, cannot stop, and does not know exist.
   */
  it('shows a successor thread what the thread before it started', async () => {
    const registry = new ServiceRegistryService();
    const first = toolsFor({ services: registry });
    const second = toolsFor({
      services: registry,
      ctx: context({
        thread: { id: 'thread-2', role: EThreadRole.builder } as unknown as Thread,
      }),
    });

    await named(first, EAtlasTool.service_start).handler({
      command: 'sleep 30',
      description: 'inherited dev server',
    });

    const id = registry.listFor(JOB)[0]?.id;
    const listed = await named(second, EAtlasTool.service_list).handler({});
    expect(listed).toContain('inherited dev server');
    expect(listed).toContain(id ?? 'no id');

    // And it can act on it, which is the half a read-only list would not prove.
    const stopped = await named(second, EAtlasTool.service_stop).handler({ id });
    expect(stopped).toContain('Stopped');

    rmSync(jobDir(JOB), { recursive: true, force: true });
  });
});

describe('service_start', () => {
  /**
   * A throw, which `atlasToolServer` renders as an `isError` result. The asymmetry with the task
   * tools is deliberate: a checklist call that misses is worth a sentence, but a start that did not
   * happen must be unmissable — the model is about to carry on as though a server were up.
   */
  it('fails as an error the agent can read when the command is missing', async () => {
    const tools = toolsFor({ services: new ServiceRegistryService() });
    const start = named(tools, EAtlasTool.service_start);

    await expect(start.handler({ description: 'web' })).rejects.toThrow(
      'service_start takes `command`',
    );
    await expect(start.handler({ command: '', description: 'web' })).rejects.toThrow(
      'Nothing was started',
    );
  });

  /**
   * The job and the default cwd come from the CONTEXT, never from an argument. A model that could
   * name someone else's job would be able to start a process in it, and one that had to repeat its
   * own cwd on every call would eventually get it wrong.
   */
  it('takes the job and the default cwd from the thread it is bound to', async () => {
    const registry = new ServiceRegistryService();
    const tools = toolsFor({ services: registry });

    await named(tools, EAtlasTool.service_start).handler({
      command: 'sleep 30',
      description: 'sleeper',
    });

    const [entry] = registry.listFor(JOB);
    expect(entry?.jobId).toBe(JOB);
    expect(entry?.cwd).toBe(tmpdir());

    registry.reapJob(JOB);
    rmSync(jobDir(JOB), { recursive: true, force: true });
  });
});

describe('service_stop', () => {
  // Unlike a start, a stop that did not happen leaves the world as it was, and every other way this
  // call can miss — an unknown id, a service already gone — is answered in prose too.
  it('answers a malformed call with a sentence rather than an error', async () => {
    const tools = toolsFor({ services: new ServiceRegistryService() });
    const reply = await named(tools, EAtlasTool.service_stop).handler({});
    expect(reply).toContain('service_stop takes `id`');
    expect(reply).toContain('Nothing was stopped');
  });

  it('answers an id this job never had by naming where the real ones are', async () => {
    const tools = toolsFor({ services: new ServiceRegistryService() });
    const reply = await named(tools, EAtlasTool.service_stop).handler({ id: 'nope' });
    expect(reply).toContain('service_list');
  });
});
