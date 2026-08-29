import { describe, expect, it } from 'bun:test'

import {
  EBeforeToolDecision,
  EToolEffect,
  toCallId,
  type ToolCall,
} from '@dltech/atlas-core'

import { createIsolatedContainer, portToken } from '../../container/injection'
import { WorkspaceRoot } from '../../container/tokens'
import { ToolDefinition } from '@dltech/atlas-core'
import { ReadTool } from '../../tools/builtin/read'
import { ResolveProjectPathsHook } from '../resolve-project-paths'

const ROOT = '/Users/dev/project'

const hook = (): ResolveProjectPathsHook => {
  const container = createIsolatedContainer()
  container.register(WorkspaceRoot, { useValue: ROOT })
  container.register(portToken(ToolDefinition), { useClass: ReadTool })
  return container.resolve(ResolveProjectPathsHook)
}

const callReading = (path: string): ToolCall => ({
  callId: toCallId('call-1'),
  name: 'read',
  input: { path },
  effect: EToolEffect.Read,
})

const inputOf = async (path: string): Promise<unknown> => {
  const outcome = await hook().run({ call: callReading(path) })
  if (outcome.decision !== EBeforeToolDecision.Allow) throw new Error('expected an allow')
  return outcome.input
}

describe('resolving a declared path against the project directory', () => {
  it('anchors a relative path to the project directory, not to wherever bash has wandered', async () => {
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

  it('passes through a call whose tool declares no paths at all', async () => {
    const outcome = await hook().run({
      call: {
        callId: toCallId('call-2'),
        name: 'bash',
        input: { command: 'ls' },
        effect: EToolEffect.Destructive,
      },
    })

    expect(outcome).toEqual({ decision: EBeforeToolDecision.Allow, input: { command: 'ls' } })
  })
})
