import { describe, expect, it } from 'bun:test'

import {
  AfterToolHook,
  BeforeToolHook,
  EDefinitionOrigin,
  EHookPhase,
  EStage,
  OnChunkHook,
  PromptFragment,
} from '@dltech/atlas-core'
import {
  createIsolatedContainer,
  disposeAll,
  portToken,
  resolveSet,
  type DependencyContainer,
} from '@dltech/atlas-harness'

import { loadPlugins, type OriginatedPlugin } from '../load'
import { defineProjection } from '../projection'
import { NativePlugin, type PluginContribution, type PluginHost } from '../plugin'

const HOST = {} as PluginHost

const host = (): PluginHost => HOST

const order = { stage: EStage.Observe, nudge: 10 }

const observing = (name: string): PluginContribution => ({
  hooks: [{ phase: EHookPhase.AfterTool, name, order, run: async () => ({}) }],
})

class Native extends NativePlugin {
  constructor(
    readonly id: string,
    private readonly contribution: PluginContribution | (() => Promise<PluginContribution>),
  ) {
    super()
  }

  contribute(): PluginContribution | Promise<PluginContribution> {
    return typeof this.contribution === 'function' ? this.contribution() : this.contribution
  }
}

const native = (
  id: string,
  contribution: PluginContribution | (() => Promise<PluginContribution>),
): OriginatedPlugin => ({ origin: EDefinitionOrigin.BuiltIn, plugin: new Native(id, contribution) })

const repo = (args: {
  id: string
  origin: EDefinitionOrigin.User | EDefinitionOrigin.Project
  contribution: PluginContribution
}): OriginatedPlugin => ({
  origin: args.origin,
  plugin: { id: args.id, register: () => args.contribution },
})

const afterToolNames = (container: DependencyContainer): readonly string[] =>
  resolveSet({ container, token: portToken(AfterToolHook) }).map((hook) => hook.name)

const load = (plugins: readonly OriginatedPlugin[], budgetMs = 20) => {
  const container = createIsolatedContainer()
  return loadPlugins({ plugins, host, container, budgetMs }).then((result) => ({
    result,
    container,
  }))
}

describe('what the loader registers', () => {
  it('sends each contribution to the registry that owns it', async () => {
    class Fragment extends PromptFragment {
      readonly id = 'fragment'
      text(): string {
        return 'text'
      }
    }

    const { container } = await load([
      native('github', {
        hooks: [
          { phase: EHookPhase.AfterTool, name: 'refresh', order, run: async () => ({}) },
          { phase: EHookPhase.BeforeTool, name: 'guard', order, run: async () => ({}) as never },
          { phase: EHookPhase.OnChunk, name: 'watch', order, run: async (chunk) => chunk },
        ],
        promptFragments: [new Fragment()],
      }),
    ])

    expect(afterToolNames(container)).toEqual(['github:refresh'])
    expect(resolveSet({ container, token: portToken(BeforeToolHook) })).toHaveLength(1)
    expect(resolveSet({ container, token: portToken(OnChunkHook) })).toHaveLength(1)
    expect(resolveSet({ container, token: portToken(PromptFragment) })).toHaveLength(1)
  })

  it('namespaces every hook with the plugin that contributed it', async () => {
    const { container } = await load([
      native('alpha', observing('tick')),
      native('beta', observing('tick')),
    ])

    expect([...afterToolNames(container)].sort()).toEqual(['alpha:tick', 'beta:tick'])
  })

  it('leaves a slot nobody contributed to empty rather than holding a phantom', async () => {
    const { container } = await load([native('quiet', {})])

    expect(resolveSet({ container, token: portToken(AfterToolHook) })).toEqual([])
  })
})

describe('shadowing and layering', () => {
  abstract class Greeter {
    abstract greet(): string
  }

  const greeting = (text: string): PluginContribution => ({
    ports: [{ token: Greeter, use: { greet: () => text } }],
  })

  it('lets a project plugin beat a user plugin of the same id', async () => {
    const { result, container } = await load([
      repo({ id: 'comp', origin: EDefinitionOrigin.User, contribution: observing('from-user') }),
      repo({
        id: 'comp',
        origin: EDefinitionOrigin.Project,
        contribution: observing('from-project'),
      }),
    ])

    expect(afterToolNames(container)).toEqual(['project:comp:from-project'])
    expect(result.loaded).toEqual([{ id: 'comp', origin: EDefinitionOrigin.Project }])
    expect(result.shadowed).toEqual([{ id: 'comp', origin: EDefinitionOrigin.User }])
  })

  it('layers a repo plugin over the native whose id it shares rather than replacing it', async () => {
    const { result, container } = await load([
      native('github', observing('from-builtin')),
      repo({ id: 'github', origin: EDefinitionOrigin.User, contribution: observing('from-user') }),
      repo({
        id: 'github',
        origin: EDefinitionOrigin.Project,
        contribution: observing('from-project'),
      }),
    ])

    expect(afterToolNames(container)).toEqual([
      'github:from-builtin',
      'project:github:from-project',
    ])
    expect(result.loaded).toEqual([
      { id: 'github', origin: EDefinitionOrigin.BuiltIn },
      { id: 'github', origin: EDefinitionOrigin.Project },
    ])
    expect(result.shadowed).toEqual([{ id: 'github', origin: EDefinitionOrigin.User }])
  })

  it('lets a layered plugin take over a port the native bound', async () => {
    const { container } = await load([
      native('github', greeting('from-builtin')),
      repo({ id: 'github', origin: EDefinitionOrigin.User, contribution: greeting('from-user') }),
    ])

    expect(container.resolve(portToken(Greeter)).greet()).toBe('from-user')
    expect(resolveSet({ container, token: portToken(Greeter) })).toHaveLength(2)
  })

  it('names a layered plugin by its origin so two of one id stay apart', async () => {
    const { result } = await load([
      native('github', { surfaces: [() => ({})] }),
      repo({
        id: 'github',
        origin: EDefinitionOrigin.User,
        contribution: { surfaces: [() => ({})] },
      }),
    ])

    expect(result.surfaces.map((surface) => surface.pluginId)).toEqual(['github', 'user:github'])
  })

  it('never calls register on a plugin that lost', async () => {
    let ran = false
    const { container } = await load([
      {
        origin: EDefinitionOrigin.User,
        plugin: {
          id: 'comp',
          register: () => {
            ran = true
            return observing('from-user')
          },
        },
      },
      repo({
        id: 'comp',
        origin: EDefinitionOrigin.Project,
        contribution: observing('from-project'),
      }),
    ])

    expect(ran).toBe(false)
    expect(afterToolNames(container)).toEqual(['project:comp:from-project'])
  })
})

describe('a plugin that misbehaves costs only itself', () => {
  it('refuses one whose contribute throws, and loads the rest', async () => {
    const { result, container } = await load([
      native('broken', () => Promise.reject(new Error('boom'))),
      native('fine', observing('tick')),
    ])

    expect(result.refused).toEqual([
      { id: 'broken', origin: EDefinitionOrigin.BuiltIn, reason: 'threw: boom' },
    ])
    expect(result.loaded.map((entry) => entry.id)).toEqual(['fine'])
    expect(afterToolNames(container)).toEqual(['fine:tick'])
  })

  it('refuses one that hangs, at the budget', async () => {
    const { result } = await load([
      native('hanger', () => new Promise<PluginContribution>(() => {})),
      native('fine', observing('tick')),
    ])

    expect(result.refused.map((entry) => entry.id)).toEqual(['hanger'])
    expect(result.loaded.map((entry) => entry.id)).toEqual(['fine'])
  })
})

describe('disposal', () => {
  it('collects a plugin dispose into the teardown the composition root already runs', async () => {
    let closed = 0
    const { container } = await load([native('github', { dispose: () => void (closed += 1) })])

    await disposeAll({ container })

    expect(closed).toBe(1)
  })
})

describe('what register returned is checked before it is registered', () => {
  it('refuses a hook whose run is missing rather than registering an undefined run', async () => {
    const { result, container } = await load([
      native('broken', { hooks: [{ phase: EHookPhase.AfterTool, name: 'half' }] } as never),
      native('fine', observing('tick')),
    ])

    expect(result.refused.map((entry) => entry.id)).toEqual(['broken'])
    expect(afterToolNames(container)).toEqual(['fine:tick'])
  })

  it('refuses a register that returned something that is not a contribution', async () => {
    const { result } = await load([native('rogue', (() => Promise.resolve('nope')) as never)])

    expect(result.refused.map((entry) => entry.id)).toEqual(['rogue'])
  })
})

describe('projections', () => {
  const counting = (id: string) => defineProjection({ id, fold: ({ events }) => events.length })

  it('collects each projection against the plugin that declared it', async () => {
    const { result } = await load([
      native('plan', { projections: [counting('plan')] }),
      repo({
        id: 'comp',
        origin: EDefinitionOrigin.User,
        contribution: { projections: [counting('one'), counting('two')] },
      }),
    ])

    expect(result.projections.map((entry) => entry.pluginId)).toEqual([
      'plan',
      'user:comp',
      'user:comp',
    ])
    expect(result.projections.map((entry) => entry.projection.id)).toEqual(['plan', 'one', 'two'])
  })

  it('collects no projection from a plugin that was refused', async () => {
    const { result } = await load([native('broken', () => Promise.reject(new Error('boom')))])

    expect(result.projections).toEqual([])
  })
})

describe('surfaces', () => {
  it('collects each contributed surface hook against the plugin that gave it', async () => {
    const paint = () => ({})
    const { result } = await load([
      native('github', { surfaces: [paint] }),
      native('shells', { surfaces: [paint, paint] }),
    ])

    expect(result.surfaces.map((surface) => surface.pluginId)).toEqual([
      'github',
      'shells',
      'shells',
    ])
  })

  it('contributes no surface for a plugin that was refused', async () => {
    const { result } = await load([native('broken', () => Promise.reject(new Error('boom')))])

    expect(result.surfaces).toEqual([])
  })
})

describe('the host is built only for the plugins that receive one', () => {
  const exploding = (): PluginHost => {
    throw new Error('Cannot inject the dependency "prisma"')
  }

  it('loads a native even when the host cannot be built', async () => {
    const container = createIsolatedContainer()
    const result = await loadPlugins({
      plugins: [native('github', observing('tick'))],
      host: exploding,
      container,
      budgetMs: 20,
    })

    expect(result.refused).toEqual([])
    expect(result.loaded.map((entry) => entry.id)).toEqual(['github'])
    expect(afterToolNames(container)).toEqual(['github:tick'])
  })

  it('refuses a repo plugin by name when its host cannot be built', async () => {
    const result = await loadPlugins({
      plugins: [
        repo({
          id: 'comp',
          origin: EDefinitionOrigin.Project,
          contribution: observing('tick'),
        }),
      ],
      host: exploding,
      container: createIsolatedContainer(),
      budgetMs: 20,
    })

    expect(result.loaded).toEqual([])
    expect(result.refused[0]?.id).toBe('comp')
    expect(result.refused[0]?.reason).toContain('prisma')
  })
})
