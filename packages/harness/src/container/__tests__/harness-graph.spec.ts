import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import { EventLogPort, toCallId, toRunId, toThreadId, type Chunk } from '@dltech/atlas-core'

import { ToolDispatcher } from '../../tools/dispatch'
import { ToolRegistry } from '../../tools/registry'
import { createHarnessContainer } from '../create-harness-container'
import { portToken, type DependencyContainer } from '../injection'
import { HookChainToken, WorkspaceRoot } from '../tokens'

const SESSION_DIRECTORY = '/workspace'

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
      'agent_list',
      'agent_resume',
      'agent_say',
      'agent_spawn',
      'agent_stop',
      'bash',
      'edit',
      'glob',
      'grep',
      'read',
      'shell_kill',
      'shell_list',
      'shell_output',
      'task_write',
      'write',
    ])
  })

  it('resolves the guard into the before-tool phase and the recorder into after-tool, not phantoms', async () => {
    const hooks = rooted().resolve(HookChainToken)
    const delta: Chunk = { type: 'text-delta', id: 'block-1', text: 'hello' }

    expect(hooks.beforeTool.map((hook) => hook.name)).toEqual([
      'resolveProjectPaths',
      'readBeforeWrite',
    ])
    expect(hooks.afterTool.map((hook) => hook.name)).toEqual([
      'plan',
      'recordFileState',
      'track-session-directory',
    ])
    expect(await hooks.onChunk({ chunk: delta })).toBe(delta)
  })

  it('hands the hook registry out as one instance, however many collaborators ask', () => {
    const container = rooted()

    expect(container.resolve(HookChainToken)).toBe(container.resolve(HookChainToken))
  })

  it('lets a tool call reach outside the root, which no longer walls the filesystem off', async () => {
    const dispatcher = rooted().resolve(portToken(ToolDispatcher))

    const drafts = await dispatcher.dispatch({
      call: {
        callId: toCallId('call-1'),
        name: 'read',
        input: { path: '/etc/hosts' },
        runId: toRunId('run-1'),
        threadId: toThreadId('thread-1'),
      },
      signal: AbortSignal.timeout(5_000),
      sessionDirectory: SESSION_DIRECTORY,
    })

    expect(drafts.map((draft) => draft.type)).toEqual(['tool-result'])
  })

  it('refuses to resolve the event log until the root has opened a database', () => {
    expect(() => rooted().resolve(portToken(EventLogPort))).toThrow()
  })
})
