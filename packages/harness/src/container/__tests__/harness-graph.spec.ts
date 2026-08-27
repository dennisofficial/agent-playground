import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import { EventLogPort, toCallId, toRunId, type Chunk } from '@dltech/atlas-core'

import { ToolDispatcher } from '../../tools/dispatch'
import { ToolRegistry } from '../../tools/registry'
import { createHarnessContainer } from '../create-harness-container'
import { portToken, type DependencyContainer } from '../injection'
import { HookChainToken, WorkspaceRoot } from '../tokens'

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

    expect(names).toEqual([
      'bash',
      'edit',
      'glob',
      'grep',
      'read',
      'shell_kill',
      'shell_list',
      'shell_output',
      'write',
    ])
  })

  it('resolves both guards into the before-tool phase and the recorder into after-tool, not phantoms', async () => {
    const hooks = rooted().resolve(HookChainToken)
    const delta: Chunk = { type: 'text-delta', id: 'block-1', text: 'hello' }

    expect(hooks.beforeTool.map((hook) => hook.name)).toEqual([
      'workspaceBoundary',
      'readBeforeWrite',
    ])
    expect(hooks.afterTool.map((hook) => hook.name)).toEqual(['recordFileState'])
    expect(await hooks.onChunk({ chunk: delta })).toBe(delta)
  })

  it('hands the hook registry out as one instance, however many collaborators ask', () => {
    const container = rooted()

    expect(container.resolve(HookChainToken)).toBe(container.resolve(HookChainToken))
  })

  it('denies a tool call escaping the workspace root the root registered', async () => {
    const dispatcher = rooted().resolve(portToken(ToolDispatcher))

    const drafts = await dispatcher.dispatch({
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
