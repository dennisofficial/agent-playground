import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import { EventLogPort, toCallId, toRunId } from '@dltech/atlas-core'

import { ToolRegistry } from '../../tools/registry'
import { createHarnessContainer } from '../create-harness-container'
import { portToken, type DependencyContainer } from '../injection'
import { DispatchToken, HookRegistryToken, WorkspaceRoot } from '../tokens'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-graph-'))
})

const rooted = (): DependencyContainer => {
  const container = createHarnessContainer()
  container.register(WorkspaceRoot, { useValue: root })
  return container
}

describe('the harness container graph', () => {
  it('resolves the builtin tools as one registry', () => {
    const names = rooted()
      .resolve(portToken(ToolRegistry))
      .declarations()
      .map((declaration) => declaration.name)
      .sort()

    expect(names).toEqual(['bash', 'edit', 'glob', 'grep', 'read', 'write'])
  })

  it('resolves the boundary hook into the before-tool phase, not a phantom', () => {
    const hooks = rooted().resolve(HookRegistryToken)

    expect(hooks.beforeTool.map((hook) => hook.name)).toEqual(['workspaceBoundary'])
    expect(hooks.onChunk).toEqual([])
  })

  it('hands the hook registry out as one instance, however many collaborators ask', () => {
    const container = rooted()

    expect(container.resolve(HookRegistryToken)).toBe(container.resolve(HookRegistryToken))
  })

  it('denies a tool call escaping the workspace root the root registered', async () => {
    const dispatch = rooted().resolve(DispatchToken)

    const drafts = await dispatch({
      call: {
        callId: toCallId('call-1'),
        name: 'read',
        input: { path: '/etc/hosts' },
        runId: toRunId('run-1'),
      },
      signal: AbortSignal.timeout(5_000),
    })

    expect(drafts.map((draft) => draft.type)).toEqual(['tool-denied'])
  })

  it('refuses to resolve the event log until the root has opened a database', () => {
    expect(() => rooted().resolve(portToken(EventLogPort))).toThrow()
  })
})
