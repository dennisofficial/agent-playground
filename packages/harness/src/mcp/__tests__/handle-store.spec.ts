import { describe, expect, it } from 'bun:test'

import { EDefinitionOrigin, EToolEffect } from '@dltech/atlas-core'

import { HandleStore } from '../bridge/handle-store'
import { EMcpServerStatus } from '../registry/handle-status'
import type { LoadedMcpSpec } from '../config'
import { InMemoryTransport, toolInfo } from './fixture-transport'

const spec = (name: string, extras?: Partial<LoadedMcpSpec>): LoadedMcpSpec => ({
  name,
  transport: { kind: 'stdio', command: 'fixture' },
  origin: EDefinitionOrigin.Project,
  definedIn: '/fixture',
  ...extras,
})

const inMemory = (baseline?: (transport: InMemoryTransport) => void): InMemoryTransport => {
  const transport = new InMemoryTransport()
  baseline?.(transport)
  return transport
}

const storeWith = async (args: {
  specs: readonly LoadedMcpSpec[]
  baselines: Partial<Record<string, (transport: InMemoryTransport) => void>>
  connectTimeoutMs?: number
}): Promise<HandleStore> => {
  const store = new HandleStore({
    specs: args.specs,
    transportFactory: (s) => inMemory(args.baselines[s.name]),
    ...(args.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: args.connectTimeoutMs }),
  })

  await store.connectAll()
  return store
}

describe('HandleStore boot', () => {
  it('connects every spec and folds its results by status', async () => {
    const specs: LoadedMcpSpec[] = [spec('alpha'), spec('beta', { disabled: true }), spec('gamma')]
    const store = await storeWith({
      specs,
      baselines: {
        gamma: (transport) => {
          transport.failsConnect = true
        },
      },
    })

    expect(store.statusOf({ serverId: 'alpha' })?.state.status).toBe(EMcpServerStatus.Connected)
    expect(store.statusOf({ serverId: 'beta' })?.state.status).toBe(EMcpServerStatus.Disabled)
    expect(store.statusOf({ serverId: 'gamma' })?.state).toEqual({
      status: EMcpServerStatus.Failed,
      error: 'the fixture refused to connect',
    })
  })

  it('marks a server Failed once it exceeds the timeout, without holding the others', async () => {
    const specs = [spec('slow'), spec('fast')]
    const store = await storeWith({
      specs,
      connectTimeoutMs: 50,
      baselines: {
        slow: (transport) => {
          transport.connectDelayMs = 200
        },
      },
    })

    expect(store.statusOf({ serverId: 'slow' })?.state.status).toBe(EMcpServerStatus.Failed)
    expect(store.statusOf({ serverId: 'fast' })?.state.status).toBe(EMcpServerStatus.Connected)
  })
})

describe('HandleStore declarations', () => {
  it('unions the tools of every connected handle and skips the rest', async () => {
    const specs = [spec('alpha'), spec('beta'), spec('off', { disabled: true })]
    const baselines: Partial<Record<string, (transport: InMemoryTransport) => void>> = {
      alpha: (transport) => {
        transport.tools = [toolInfo({ name: 'read', annotations: { readOnlyHint: true } })]
      },
      beta: (transport) => {
        transport.tools = [toolInfo({ name: 'write' })]
      },
    }

    const store = await storeWith({ specs, baselines })

    const names = store.declarations().map((declaration) => declaration.name)
    expect(names).toEqual(['mcp__alpha__read', 'mcp__beta__write'])
  })

  it('declares nothing from a server that cannot list tools', async () => {
    const store = await storeWith({
      specs: [spec('empty')],
      baselines: {
        empty: (transport) => {
          transport.capabilities = { tools: false, prompts: false, resources: false }
        },
      },
    })

    expect(store.statusOf({ serverId: 'empty' })?.state.status).toBe(EMcpServerStatus.Connected)
    expect(store.declarations()).toEqual([])
  })
})

describe('HandleStore find', () => {
  it('resolves a joined name to the bridge of the structural server and tool', async () => {
    const store = await storeWith({
      specs: [spec('alpha')],
      baselines: {
        alpha: (transport) => {
          transport.tools = [
            toolInfo({ name: 'first' }),
            toolInfo({ name: 'second', annotations: { destructiveHint: true } }),
          ]
        },
      },
    })

    const found = store.find('mcp__alpha__second')
    expect(found?.effect).toBe(EToolEffect.Destructive)
    expect(store.find('mcp__alpha__third')).toBeUndefined()
    expect(store.find('mcp__alpha__first')).toBeDefined()
  })

  it('closes every transport it opened', async () => {
    const made = new Map<string, InMemoryTransport>()
    const store = await storeWith({
      specs: [spec('alpha'), spec('beta')],
      baselines: {
        alpha: (transport) => {
          made.set('alpha', transport)
        },
        beta: (transport) => {
          made.set('beta', transport)
        },
      },
    })

    await store.closeAll()

    expect(made.get('alpha')?.closed).toBe(true)
    expect(made.get('beta')?.closed).toBe(true)
  })
})
