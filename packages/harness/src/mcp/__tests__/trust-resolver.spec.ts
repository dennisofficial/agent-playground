import { describe, expect, it } from 'bun:test'

import { EDefinitionOrigin } from '@dltech/atlas-core'

import { HandleStore } from '../bridge/handle-store'
import { TrustResolver } from '../bridge/trust-resolver'
import type { LoadedMcpSpec } from '../config'
import { InMemoryTransport, toolInfo } from './fixture-transport'

const spec = (name: string, trusted?: boolean): LoadedMcpSpec => ({
  name,
  transport: { kind: 'stdio', command: 'fixture' },
  ...(trusted !== undefined ? { trusted } : {}),
  origin: EDefinitionOrigin.Project,
  definedIn: '/fixture',
})

const storeWith = async (specs: readonly LoadedMcpSpec[]): Promise<HandleStore> => {
  const transports = new Map<string, InMemoryTransport>()
  const store = new HandleStore({
    specs,
    transportFactory: (s) => {
      const transport = new InMemoryTransport()
      transport.tools = [toolInfo({ name: 'write' })]
      transports.set(s.name, transport)
      return transport
    },
  })

  await store.connectAll()
  return store
}

describe('TrustResolver', () => {
  it('answers the owning spec trusted flag for a structural lookup', async () => {
    const store = await storeWith([spec('alpha', true), spec('beta')])
    const resolver = new TrustResolver({ store })

    expect(resolver.trusted({ tool: 'mcp__alpha__write' })).toBe(true)
    expect(resolver.trusted({ tool: 'mcp__beta__write' })).toBe(false)
  })

  it('denies trust for a tool nobody owns', async () => {
    const store = await storeWith([spec('alpha', true)])
    const resolver = new TrustResolver({ store })

    expect(resolver.trusted({ tool: 'mcp__alpha__missing' })).toBe(false)
    expect(resolver.trusted({ tool: 'read' })).toBe(false)
  })

  it('clears trust for a disabled server', async () => {
    const blocked: LoadedMcpSpec = {
      name: 'alpha',
      transport: { kind: 'stdio', command: 'fixture' },
      trusted: true,
      disabled: true,
      origin: EDefinitionOrigin.Project,
      definedIn: '/fixture',
    }
    const store = new HandleStore({
      specs: [blocked],
      transportFactory: () => new InMemoryTransport(),
    })

    await store.connectAll()
    const resolver = new TrustResolver({ store })

    expect(resolver.trusted({ tool: 'mcp__alpha__write' })).toBe(false)
  })
})
