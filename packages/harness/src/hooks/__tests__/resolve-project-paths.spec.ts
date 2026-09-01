import { describe, expect, it } from 'bun:test'

import {
  EBeforeToolDecision,
  EToolEffect,
  toCallId,
  toThreadId,
  type ToolCall,
} from '@dltech/atlas-core'

import { createIsolatedContainer, portToken } from '../../container/injection'
import { WorkspaceRoot } from '../../container/tokens'
import { ToolDefinition } from '@dltech/atlas-core'
import { BashTool } from '../../tools/builtin/bash'
import { ReadTool } from '../../tools/builtin/read'
import { ResolveProjectPathsHook } from '../resolve-project-paths'

const ROOT = '/Users/dev/project'

const hook = (): ResolveProjectPathsHook => {
  const container = createIsolatedContainer()
  container.register(WorkspaceRoot, { useValue: ROOT })
  container.register(portToken(ToolDefinition), { useClass: ReadTool })
  container.register(portToken(ToolDefinition), { useClass: BashTool })
  return container.resolve(ResolveProjectPathsHook)
}

const callReading = (path: string): ToolCall => ({
  callId: toCallId('call-1'),
  name: 'read',
  input: { path },
  effect: EToolEffect.Read,
  threadId: toThreadId('thread-1'),
})

const callTo = (name: string, input: unknown): ToolCall => ({
  callId: toCallId('call-1'),
  name,
  input,
  effect: name === 'read' ? EToolEffect.Read : EToolEffect.Destructive,
  threadId: toThreadId('thread-1'),
})

const inputOf = async (input: unknown, name = 'read'): Promise<unknown> => {
  const call = name === 'read' && typeof input === 'string' ? callReading(input) : callTo(name, input)
  const outcome = await hook().run({ call, projectDirectory: ROOT })
  if (outcome.decision !== EBeforeToolDecision.Allow) throw new Error('expected an allow')
  return outcome.input
}

describe('resolving a declared path against the project directory', () => {
  it('anchors a relative path to the project directory', async () => {
    expect(await inputOf('apps/tui/src/main.tsx')).toEqual({
      path: `${ROOT}/apps/tui/src/main.tsx`,
    })
  })

  it('leaves an absolute path exactly as the model wrote it', async () => {
    expect(await inputOf('/etc/hosts')).toEqual({ path: '/etc/hosts' })
  })

  it('resolves a path that climbs out of the project, rather than refusing it', async () => {
    expect(await inputOf('../sibling/notes.md')).toEqual({ path: '/Users/dev/sibling/notes.md' })
  })

  it('normalises a dot-slash path to the same absolute path as the bare one', async () => {
    expect(await inputOf('./README.md')).toEqual(await inputOf('README.md'))
  })

  it('anchors a relative bash workdir to the project directory, like any other declared path', async () => {
    expect(await inputOf({ command: 'bun test', workdir: 'packages/core' }, 'bash')).toEqual({
      command: 'bun test',
      workdir: `${ROOT}/packages/core`,
    })
  })

  it('leaves a bash call that names no workdir exactly as it was', async () => {
    expect(await inputOf({ command: 'ls' }, 'bash')).toEqual({ command: 'ls' })
  })
})
