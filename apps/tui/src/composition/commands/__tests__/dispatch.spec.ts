import { ECommandGroup, ECommandKind, EContextSlot, type CommandSpec } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { dispatchSubmission, EDispatch, type LoadedSkill } from '../dispatch'
import { ECommandEcho, ECommandEffect, ECommandTiming, RAN, type LocalCommand } from '../local-command'
import { ECompactScope } from '../../compact-turn'
import { localCommands } from '../registry'

const skillSpec = (name: string): CommandSpec => ({
  name,
  kind: ECommandKind.Skill,
  summary: name,
  group: ECommandGroup.Workspace,
})

const SKILLS: readonly LoadedSkill[] = [
  { spec: skillSpec('review'), body: 'Review $ARGUMENTS carefully.' },
  { spec: skillSpec('tdd'), body: 'Write the test first.' },
]

const commandThat = (run: LocalCommand['run']): LocalCommand => ({
  name: 'demo',
  kind: ECommandKind.Local,
  summary: 'demo',
  group: ECommandGroup.Session,
  timing: ECommandTiming.Immediate,
  echo: ECommandEcho.Silent,
  run,
})

describe('dispatchSubmission', () => {
  it('sends plain prose untouched', async () => {
    const result = await dispatchSubmission({ text: 'fix the build', commands: [], skills: SKILLS })

    expect(result).toEqual({ type: EDispatch.Send, text: 'fix the build', drafts: [] })
  })

  it('sends an unknown command as prose', async () => {
    const result = await dispatchSubmission({ text: '/nope', commands: [], skills: SKILLS })

    expect(result.type).toBe(EDispatch.Send)
  })

  it('runs a local command and does not send it', async () => {
    const seen: string[] = []
    const command = commandThat(({ argumentText }) => {
      seen.push(argumentText)
      return RAN
    })

    const result = await dispatchSubmission({ text: '/demo all', commands: [command], skills: [] })

    expect(result).toEqual({ type: EDispatch.Ran })
    expect(seen).toEqual(['all'])
  })

  it('reports a refusal with its reason', async () => {
    const command = commandThat(() => ({ type: ECommandEffect.Refused, reason: 'nothing to compact' }))

    const result = await dispatchSubmission({ text: '/demo', commands: [command], skills: [] })

    expect(result).toEqual({ type: EDispatch.Refused, reason: 'nothing to compact' })
  })

  it('drafts a context-loaded per invoked skill and still sends the text', async () => {
    const result = await dispatchSubmission({
      text: '/review src/auth.ts',
      commands: [],
      skills: SKILLS,
    })

    expect(result).toEqual({
      type: EDispatch.Send,
      text: '/review src/auth.ts',
      drafts: [
        {
          type: 'context-loaded',
          slot: EContextSlot.Skill,
          key: 'review',
          content: 'Review src/auth.ts carefully.',
        },
      ],
    })
  })

  it('drafts a skill named mid-prose', async () => {
    const result = await dispatchSubmission({
      text: 'please use /tdd on this',
      commands: [],
      skills: SKILLS,
    })

    expect(result.type).toBe(EDispatch.Send)
    if (result.type !== EDispatch.Send) return
    expect(result.drafts.map((draft) => draft.type === 'context-loaded' && draft.key)).toEqual(['tdd'])
  })

  it('drafts nothing for a mention inside backticks', async () => {
    const result = await dispatchSubmission({
      text: 'type `/tdd` first',
      commands: [],
      skills: SKILLS,
    })

    expect(result.type === EDispatch.Send && result.drafts).toEqual([])
  })
})

describe('localCommands', () => {
  it('gives every command a name, a summary and a group so /help can derive itself', () => {
    const handler = () => undefined
    const commands = localCommands({
      onCompact: handler,
      onRewind: handler,
      onShortcuts: handler,
      onOpenSwitcher: handler,
      onOpenShells: handler,
      onOpenSettings: handler,
      onOpenAccounts: handler,
      onNewConversation: handler,
    })

    expect(commands.length).toBeGreaterThan(0)
    expect(commands.every((one) => one.summary !== '' && one.kind === ECommandKind.Local)).toBe(true)
  })

  it('marks the commands that must wait for the turn to settle', () => {
    const handler = () => undefined
    const commands = localCommands({
      onCompact: handler,
      onRewind: handler,
      onShortcuts: handler,
      onOpenSwitcher: handler,
      onOpenShells: handler,
      onOpenSettings: handler,
      onOpenAccounts: handler,
      onNewConversation: handler,
    })

    const settled = commands.filter((one) => one.timing === ECommandTiming.Settled)

    expect(settled.map((one) => one.name).sort()).toEqual(['compact', 'new'])
  })
})

describe('the compact command and its scope', () => {
  const commandsWith = (onCompact: (scope: ECompactScope) => void) => {
    const handler = () => undefined
    return localCommands({
      onCompact,
      onRewind: handler,
      onShortcuts: handler,
      onOpenSwitcher: handler,
      onOpenShells: handler,
      onOpenSettings: handler,
      onOpenAccounts: handler,
      onNewConversation: handler,
    })
  }

  it('compacts only the older turns when asked with no argument', async () => {
    const asked: ECompactScope[] = []

    await dispatchSubmission({ text: '/compact', commands: commandsWith((s) => asked.push(s)), skills: [] })

    expect(asked).toEqual([ECompactScope.Recent])
  })

  it('compacts the whole conversation when asked for all', async () => {
    const asked: ECompactScope[] = []

    await dispatchSubmission({
      text: '/compact all',
      commands: commandsWith((s) => asked.push(s)),
      skills: [],
    })

    expect(asked).toEqual([ECompactScope.Everything])
  })

  it('refuses an argument it does not understand rather than compacting something else', async () => {
    const asked: ECompactScope[] = []

    const dispatched = await dispatchSubmission({
      text: '/compact everything',
      commands: commandsWith((s) => asked.push(s)),
      skills: [],
    })

    expect(dispatched.type).toBe(EDispatch.Refused)
    expect(asked).toEqual([])
  })

  it('refuses to rewrite history while a turn is still reading it', async () => {
    const asked: ECompactScope[] = []

    const dispatched = await dispatchSubmission({
      text: '/compact',
      commands: commandsWith((s) => asked.push(s)),
      skills: [],
      working: true,
    })

    expect(dispatched.type).toBe(EDispatch.Refused)
    expect(dispatched.type === EDispatch.Refused && dispatched.reason).toContain('wait for the turn')
    expect(asked).toEqual([])
  })

  it('still opens an overlay mid-turn, because that rewrites nothing', async () => {
    const opened: string[] = []
    const handler = () => undefined
    const commands = localCommands({
      onCompact: handler,
      onRewind: () => opened.push('rewind'),
      onShortcuts: handler,
      onOpenSwitcher: handler,
      onOpenShells: handler,
      onOpenSettings: handler,
      onOpenAccounts: handler,
      onNewConversation: handler,
    })

    await dispatchSubmission({ text: '/rewind', commands, skills: [], working: true })

    expect(opened).toEqual(['rewind'])
  })
})

