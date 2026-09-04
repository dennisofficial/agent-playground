import { beforeAll, describe, expect, it } from 'bun:test'

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { toThreadId, type ProcessPort, type ToolOutcome } from '@dltech/atlas-core'

import { LocalFileSystemPort } from '../../../execution/local-filesystem'
import { HookChain } from '../../../hooks/registry'
import { BunShellRegistry } from '../../../shells/shell-registry'
import { SystemClock } from '../../../store'
import { BashTool } from '../bash'

const noHooks = () => new HookChain({})

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-bash-exposure-'))
})

const invokeWith = (tool: BashTool, input: Record<string, unknown>): Promise<ToolOutcome> =>
  tool.invoke({
    input: { description: 'Exercise the shell', ...input },
    signal: new AbortController().signal,
    idempotencyKey: `bash-exposure-${crypto.randomUUID()}`,
    projectDirectory: root,
    threadId: toThreadId('thread-1'),
  })

const invoke = (input: Record<string, unknown>): Promise<ToolOutcome> =>
  invokeWith(new BashTool(new BunShellRegistry(root, new SystemClock(), noHooks)), input)

describe('exposing a port from a background shell', () => {
  it('refuses exposePort without runInBackground, the way watch is refused', async () => {
    const outcome = await invoke({ command: 'echo hi', exposePort: 3000 })

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain('runInBackground')
  })

  it('starts an exposed background shell with the mapping in the output and the URL in modelText', async () => {
    const outcome = await invoke({ command: 'sleep 30', runInBackground: true, exposePort: 3000 })
    if (!outcome.ok) throw new Error(outcome.reason)

    expect(outcome.output).toMatchObject({
      exposure: { containerPort: 3000, hostPort: 3000, url: 'http://localhost:3000' },
    })
    expect(outcome.modelText).toContain('http://localhost:3000')
  })

  it('refuses when the execution port cannot publish ports, before anything starts', async () => {
    const bare: ProcessPort = {
      spawn: () => {
        throw new Error('unused')
      },
      which: () => null,
    }
    const tool = new BashTool(
      new BunShellRegistry(root, new SystemClock(), noHooks),
      new LocalFileSystemPort(),
      bare,
    )

    const outcome = await invokeWith(tool, {
      command: 'sleep 30',
      runInBackground: true,
      exposePort: 3000,
    })

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain('publish')
  })
})
