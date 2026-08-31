import { afterEach, describe, expect, it } from 'bun:test'

import {
  defaultPipeline,
  EAgentStatus,
  EPromptAgent,
  EventLogPort,
  IdPort,
  ModelPort,
  promptContextFor,
  type ThreadId,
} from '@dltech/atlas-core'

import { AgentRegistryPort } from '../../agents/registry/port'
import { subAgentPrompt } from '../../agents/registry/child-prompt'
import type { ChildRunnerDeps } from '../../agents/registry/child-runner'
import { createTempDatabase, type TempDatabase } from '../../loop/__tests__/temp-database'
import { scriptedModel } from '../../model/testing/scripted-model'
import { openAtlasDatabase } from '../../store/database'
import { ThreadStorePort } from '../../store'
import { PromptRegistry } from '../../prompt/registry'
import { ToolRegistry } from '../../tools/registry'
import { ToolDispatcher } from '../../tools/dispatch'
import { ChildRunnerDepsToken, createHarnessContainer } from '../create-harness-container'
import { portToken, type DependencyContainer } from '../injection'
import {
  HookChainToken,
  LanguageModelToken,
  PrismaClientToken,
  WorkspaceRoot,
} from '../tokens'

const ROOT = '/workspace/atlas'

const CHILD_REPLY = 'The vault reads its key file exactly once.'

const opened: { close: () => Promise<void>; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.close()
    entry.temp.discard()
  }
})

/**
 * The composition root's binding, reproduced: the supervisor resolves ChildRunnerDepsToken lazily
 * at the first spawn, so an unbound token is a runtime failure inside the child rather than a
 * resolution failure anyone would notice.
 */
function bindChildRunner({ container }: { container: DependencyContainer }): void {
  container.register(ChildRunnerDepsToken, {
    useValue: (): ChildRunnerDeps => {
      const modelPort = container.resolve(portToken(ModelPort))
      const prompts = container.resolve(portToken(PromptRegistry))

      return {
        turn: {
          log: container.resolve(portToken(EventLogPort)),
          model: modelPort,
          ids: container.resolve(portToken(IdPort)),
          assembly: defaultPipeline({
            prompt: () =>
              prompts.compile(
                promptContextFor({ agent: EPromptAgent.Main, provider: modelPort.identity }),
              ),
            projectDirectory: ROOT,
          }),
          projectDirectory: ROOT,
          dispatch: container.resolve(portToken(ToolDispatcher)),
          hooks: container.resolve(HookChainToken),
        },
        tools: container.resolve(portToken(ToolRegistry)),
        hooks: container.resolve(HookChainToken),
        assemblyFor: ({ agentType }) =>
          defaultPipeline({
            prompt: () =>
              subAgentPrompt({ prompts, agentType, provider: modelPort.identity }),
            projectDirectory: ROOT,
          }),
      }
    },
  })
}

async function composed(args: { bind: boolean }): Promise<{
  agents: AgentRegistryPort
  threads: ThreadStorePort
  parent: ThreadId
}> {
  const temp = createTempDatabase()
  const database = await openAtlasDatabase({ databaseUrl: temp.databaseUrl })

  const container = createHarnessContainer()
  container.register(WorkspaceRoot, { useValue: ROOT })
  container.register(PrismaClientToken, { useValue: database.prisma })
  container.register(LanguageModelToken, {
    useValue: scriptedModel({ script: [{ text: CHILD_REPLY }] }),
  })
  if (args.bind) bindChildRunner({ container })

  opened.push({ close: database.close, temp })

  const threads = container.resolve(portToken(ThreadStorePort))
  const parent = (await threads.create({ workspace: ROOT, repo: null })).id

  return { agents: container.resolve(portToken(AgentRegistryPort)), threads, parent }
}

const settled = async (agents: AgentRegistryPort, agentId: ThreadId): Promise<EAgentStatus> => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const found = agents.listEverywhere().find((one) => one.agentId === agentId)
    if (found !== undefined && found.status !== EAgentStatus.Running) return found.status
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the child never settled')
}

describe('a child spawned through the container', () => {
  it('takes a step and finishes rather than dying on its own wiring', async () => {
    const { agents, parent } = await composed({ bind: true })

    const outcome = await agents.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'audit the credential vault',
      intent: 'vault audit',
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(await settled(agents, outcome.snapshot.agentId)).toBe(EAgentStatus.Finished)
  }, 30_000)

  it('fails instantly when nothing binds the child runner deps, which is the bug this guards', async () => {
    const { agents, parent } = await composed({ bind: false })

    const outcome = await agents.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'audit the credential vault',
      intent: 'vault audit',
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(await settled(agents, outcome.snapshot.agentId)).toBe(EAgentStatus.Failed)
  }, 30_000)
})

describe('the ending a parent is meant to be woken by', () => {
  it('reaches onNotice and pendingNotices through the real supervisor', async () => {
    const { agents, parent } = await composed({ bind: true })

    let announcements = 0
    agents.onNotice(() => {
      announcements += 1
    })

    const outcome = await agents.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'audit the credential vault',
      intent: 'vault audit',
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(await settled(agents, outcome.snapshot.agentId)).toBe(EAgentStatus.Finished)

    expect(announcements).toBeGreaterThan(0)
    expect(agents.pendingNotices({ threadId: parent })).toHaveLength(1)
    expect(agents.threadsAwaitingNotice()).toEqual([parent])
  }, 30_000)

  it('hands the same array back until the queue changes, so a store can read it on every render', async () => {
    const { agents, parent } = await composed({ bind: true })

    const outcome = await agents.spawn({
      threadId: parent,
      agentType: 'explore',
      brief: 'audit the credential vault',
      intent: 'vault audit',
    })
    if (!outcome.ok) return
    await settled(agents, outcome.snapshot.agentId)

    const first = agents.pendingNotices({ threadId: parent })
    expect(agents.pendingNotices({ threadId: parent })).toBe(first)

    expect(agents.drainNotifications({ threadId: parent })).toHaveLength(1)
    expect(agents.pendingNotices({ threadId: parent })).toHaveLength(0)
  }, 30_000)
})
