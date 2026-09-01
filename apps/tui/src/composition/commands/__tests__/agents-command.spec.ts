import { EAgentStatus, type ThreadId } from '@dltech/atlas-core'
import type { AgentSnapshot } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import { ESubagentReading } from '../../../store/subagent-row'
import { agentChoices, type AgentChoice } from '../agent-choices'
import { dispatchSubmission, EDispatch, type Dispatch } from '../dispatch'
import { agentsAskOfArgument, EAgentsAsk, localCommands } from '../registry'
import { handlers } from './local-handlers'

const PARENT = 'parent' as ThreadId

const child = (args: {
  id: string
  status: EAgentStatus
  startedAt: string
  endedAt?: string
}): AgentSnapshot => ({
  agentId: args.id as ThreadId,
  spawnedBy: PARENT,
  agentType: 'general-purpose',
  intent: args.id,
  status: args.status,
  turns: 1,
  toolCalls: 2,
  lastTool: undefined,
  startedAt: args.startedAt,
  endedAt: args.endedAt,
})

const RUNNING = child({
  id: 'still going',
  status: EAgentStatus.Running,
  startedAt: '2026-08-31T10:00:00.000Z',
})

const FINISHED = child({
  id: 'finished an hour ago',
  status: EAgentStatus.Finished,
  startedAt: '2026-08-31T08:00:00.000Z',
  endedAt: '2026-08-31T09:00:00.000Z',
})

const FAILED = child({
  id: 'fell over',
  status: EAgentStatus.Failed,
  startedAt: '2026-08-31T07:00:00.000Z',
  endedAt: '2026-08-31T07:30:00.000Z',
})

const offering = (agents: readonly AgentSnapshot[]) => {
  const offered: AgentChoice[] = []

  return {
    offered,
    onOpenAgents: (): boolean => {
      const choices = agentChoices({ agents })
      offered.push(...choices)
      return choices.length > 0
    },
  }
}

type Asked = { dispatched: Dispatch; offered: readonly AgentChoice[] }

const askAgents = async (args: {
  text: string
  agents: readonly AgentSnapshot[]
}): Promise<Asked> => {
  const offer = offering(args.agents)

  const dispatched = await dispatchSubmission({
    text: args.text,
    commands: localCommands(handlers({ onOpenAgents: offer.onOpenAgents })),
    skills: [],
  })

  return { dispatched, offered: offer.offered }
}

describe('the agents command', () => {
  it('offers the children of a conversation that has some', async () => {
    let walked = 0
    const dispatched = await dispatchSubmission({
      text: '/agents',
      commands: localCommands(handlers({ onOpenAgents: () => ++walked > 0 })),
      skills: [],
    })

    expect(dispatched).toEqual({ type: EDispatch.Ran })
    expect(walked).toBe(1)
  })

  it('says there is nobody to read rather than looking like it did something', async () => {
    const dispatched = await dispatchSubmission({
      text: '/agents',
      commands: localCommands(handlers({ onOpenAgents: () => false })),
      skills: [],
    })

    expect(dispatched.type).toBe(EDispatch.Refused)
    expect(dispatched.type === EDispatch.Refused && dispatched.reason).toContain('no sub-agent')
  })

  it('offers a child that has settled as well as one that is still going', async () => {
    const { dispatched, offered } = await askAgents({
      text: '/agents',
      agents: [RUNNING, FINISHED],
    })

    expect(dispatched).toEqual({ type: EDispatch.Ran })
    expect(offered.map((one) => one.name)).toEqual(['still going', 'finished an hour ago'])
  })

  it('states the outcome of every settled child it offers', async () => {
    const { offered } = await askAgents({ text: '/agents', agents: [RUNNING, FINISHED, FAILED] })

    expect(offered.map((one) => [one.name, one.state])).toEqual([
      ['still going', 'running'],
      ['finished an hour ago', 'done'],
      ['fell over', 'failed'],
    ])
  })

  it('reads a conversation whose children have all settled, rather than calling it empty', async () => {
    const { dispatched, offered } = await askAgents({ text: '/agents', agents: [FINISHED, FAILED] })

    expect(dispatched).toEqual({ type: EDispatch.Ran })
    expect(offered.map((one) => one.tone)).toEqual([
      ESubagentReading.Settled,
      ESubagentReading.Settled,
    ])
  })

  it('still says there is nobody to read when the conversation spawned nothing at all', async () => {
    const { dispatched } = await askAgents({ text: '/agents', agents: [] })

    expect(dispatched.type).toBe(EDispatch.Refused)
    expect(dispatched.type === EDispatch.Refused && dispatched.reason).toContain('no sub-agent')
  })

  it('lists the types on disk when asked for them, without offering the children', async () => {
    let walked = 0
    let listed = 0
    const dispatched = await dispatchSubmission({
      text: '/agents types',
      commands: localCommands(
        handlers({
          onOpenAgents: () => ++walked > 0,
          onShowAgentTypes: () => void (listed += 1),
        }),
      ),
      skills: [],
    })

    expect(dispatched).toEqual({ type: EDispatch.Ran })
    expect(listed).toBe(1)
    expect(walked).toBe(0)
  })

  it('lists the types even when the conversation has no child, because they are unrelated questions', async () => {
    let listed = 0
    const dispatched = await dispatchSubmission({
      text: '/agents types',
      commands: localCommands(
        handlers({ onOpenAgents: () => false, onShowAgentTypes: () => void (listed += 1) }),
      ),
      skills: [],
    })

    expect(dispatched).toEqual({ type: EDispatch.Ran })
    expect(listed).toBe(1)
  })

  it('names the children the last process lost, without offering the ones it holds', async () => {
    let walked = 0
    let shown = 0
    const dispatched = await dispatchSubmission({
      text: '/agents lost',
      commands: localCommands(
        handlers({
          onOpenAgents: () => ++walked > 0,
          onShowLostAgents: () => {
            shown += 1
            return true
          },
        }),
      ),
      skills: [],
    })

    expect(dispatched).toEqual({ type: EDispatch.Ran })
    expect(shown).toBe(1)
    expect(walked).toBe(0)
  })

  it('says nothing was lost rather than opening an empty panel', async () => {
    const dispatched = await dispatchSubmission({
      text: '/agents lost',
      commands: localCommands(handlers({ onShowLostAgents: () => false })),
      skills: [],
    })

    expect(dispatched.type).toBe(EDispatch.Refused)
    expect(dispatched.type === EDispatch.Refused && dispatched.reason).toBe(
      'nothing was lost when this conversation was opened',
    )
  })

  it('says what it takes rather than guessing at an argument it does not know', async () => {
    const dispatched = await dispatchSubmission({
      text: '/agents kinds',
      commands: localCommands(handlers()),
      skills: [],
    })

    expect(dispatched.type).toBe(EDispatch.Refused)
    expect(dispatched.type === EDispatch.Refused && dispatched.reason).toBe(
      '/agents takes no argument to read a sub-agent of this conversation, "types" to list the agent types on disk, or "lost" to name the ones this conversation opened without recording — not kinds',
    )
  })
})

describe('what /agents was asked for', () => {
  it('reads a bare invocation as the children of this conversation', () => {
    expect(agentsAskOfArgument('')).toBe(EAgentsAsk.Children)
    expect(agentsAskOfArgument('   ')).toBe(EAgentsAsk.Children)
  })

  it('reads types however it is cased or spaced', () => {
    expect(agentsAskOfArgument('types')).toBe(EAgentsAsk.Types)
    expect(agentsAskOfArgument('  TYPES ')).toBe(EAgentsAsk.Types)
  })

  it('reads lost however it is cased or spaced', () => {
    expect(agentsAskOfArgument('lost')).toBe(EAgentsAsk.Lost)
    expect(agentsAskOfArgument('  LOST ')).toBe(EAgentsAsk.Lost)
  })

  it('refuses anything else rather than falling back to a default', () => {
    expect(agentsAskOfArgument('kinds')).toBe(null)
    expect(agentsAskOfArgument('type')).toBe(null)
  })
})

describe('the summary /help reads out for the agents command', () => {
  it('does not promise only the sub-agents that are still running', () => {
    const agents = localCommands(handlers()).find((one) => one.name === 'agents')

    expect(agents?.summary).toBe(
      'read a sub-agent this conversation has spawned, running or finished, or list the agent types on disk',
    )
  })
})
