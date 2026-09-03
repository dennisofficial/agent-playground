import { ECommandGroup, ECommandKind, EContextSlot, type CommandSpec } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { dispatchSubmission, EDispatch, type LoadedSkill } from '../dispatch'
import { ECommandEcho, ECommandEffect, ECommandTiming, RAN, type LocalCommand } from '../local-command'
import { ECompactScope } from '../../compact-turn'
import { ERenamed } from '../../session-rename'
import { localCommands } from '../registry'
import { handlers } from './local-handlers'

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

  it('attaches a file the developer mentioned', async () => {
    const dispatched = await dispatchSubmission({
      text: 'why is @src/app.ts broken',
      commands: [],
      skills: [],
      loadFile: async (path) => ({ path, content: 'the file' }),
    })

    expect(dispatched).toEqual({
      type: EDispatch.Send,
      text: 'why is @src/app.ts broken',
      drafts: [
        {
          type: 'context-loaded',
          slot: EContextSlot.File,
          key: 'src/app.ts',
          content: 'the file',
        },
      ],
    })
  })

  it('attaches a mentioned file alongside an invoked skill', async () => {
    const dispatched = await dispatchSubmission({
      text: '/review @src/app.ts',
      commands: [],
      skills: SKILLS,
      loadFile: async (path) => ({ path, content: 'the file' }),
    })

    const slots =
      dispatched.type === EDispatch.Send
        ? dispatched.drafts.map((draft) =>
            draft.type === 'context-loaded' ? draft.slot : draft.type,
          )
        : []
    expect(slots).toEqual([EContextSlot.Skill, EContextSlot.File])
  })

  it('attaches nothing for a local command line', async () => {
    const asked: string[] = []

    const dispatched = await dispatchSubmission({
      text: '/demo @src/app.ts',
      commands: [commandThat(() => RAN)],
      skills: [],
      loadFile: async (path) => {
        asked.push(path)
        return { path, content: 'the file' }
      },
    })

    expect(dispatched).toEqual({ type: EDispatch.Ran })
    expect(asked).toEqual([])
  })
})

describe('localCommands', () => {
  it('gives every command a name, a summary and a group so /help can derive itself', () => {
    const commands = localCommands(handlers())

    expect(commands.length).toBeGreaterThan(0)
    expect(commands.every((one) => one.summary !== '' && one.kind === ECommandKind.Local)).toBe(true)
  })

  it('marks the commands that must wait for the turn to settle', () => {
    const commands = localCommands(handlers())

    const settled = commands.filter((one) => one.timing === ECommandTiming.Settled)

    expect(settled.map((one) => one.name).sort()).toEqual(['compact', 'new', 'resume'])
  })
})

describe('the new command and its alias', () => {
  it('starts a fresh conversation on /new and on /clear alike', async () => {
    const started: string[] = []
    const commands = localCommands(handlers({ onNewConversation: () => started.push('new') }))

    await dispatchSubmission({ text: '/new', commands, skills: [] })
    await dispatchSubmission({ text: '/clear', commands, skills: [] })

    expect(started).toEqual(['new', 'new'])
  })

  it('waits for the turn to settle under either name', async () => {
    const dispatched = await dispatchSubmission({
      text: '/clear',
      commands: localCommands(handlers()),
      skills: [],
      working: true,
    })

    expect(dispatched.type).toBe(EDispatch.Refused)
    expect(dispatched.type === EDispatch.Refused && dispatched.reason).toContain('wait for the turn')
  })
})

describe('the skills command', () => {
  it('reloads and reports what the reload holds', async () => {
    let reloads = 0

    const dispatched = await dispatchSubmission({
      text: '/skills',
      commands: localCommands(
        handlers({
          onReloadSkills: async () => {
            reloads += 1
            return { loaded: 3, added: ['shanty'], removed: [] }
          },
        }),
      ),
      skills: [],
    })

    expect(reloads).toBe(1)
    expect(dispatched).toEqual({ type: EDispatch.Ran, notice: '3 skills — added shanty' })
  })

  it('reloads mid-turn, because nothing already in the prompt is rewritten', async () => {
    const dispatched = await dispatchSubmission({
      text: '/skills',
      commands: localCommands(handlers()),
      skills: [],
      working: true,
    })

    expect(dispatched.type).toBe(EDispatch.Ran)
  })
})

describe('the rename command', () => {
  it('passes the name the operator wrote through to the rename', async () => {
    const asked: string[] = []

    const dispatched = await dispatchSubmission({
      text: '/rename Doing something cool',
      commands: localCommands(
        handlers({
          onRename: async (argumentText) => {
            asked.push(argumentText)
            return { type: ERenamed.Renamed, name: argumentText }
          },
        }),
      ),
      skills: [],
    })

    expect(dispatched).toEqual({ type: EDispatch.Ran })
    expect(asked).toEqual(['Doing something cool'])
  })

  it('asks for a name from the transcript when the operator wrote none', async () => {
    const asked: string[] = []

    await dispatchSubmission({
      text: '/rename',
      commands: localCommands(
        handlers({
          onRename: async (argumentText) => {
            asked.push(argumentText)
            return { type: ERenamed.Renamed, name: 'Rotating refresh tokens' }
          },
        }),
      ),
      skills: [],
    })

    expect(asked).toEqual([''])
  })

  it('renames mid-turn, because a name changes nothing the turn is reading', async () => {
    const dispatched = await dispatchSubmission({
      text: '/rename Doing something cool',
      commands: localCommands(handlers()),
      skills: [],
      working: true,
    })

    expect(dispatched).toEqual({ type: EDispatch.Ran })
  })

  it('says what to do when there is nothing said yet to name the session from', async () => {
    const dispatched = await dispatchSubmission({
      text: '/rename',
      commands: localCommands(handlers({ onRename: async () => ({ type: ERenamed.Empty }) })),
      skills: [],
    })

    expect(dispatched.type).toBe(EDispatch.Refused)
    expect(dispatched.type === EDispatch.Refused && dispatched.reason).toContain('/rename Doing something cool')
  })

  it('says so when no name comes back, rather than leaving the ask silent', async () => {
    const dispatched = await dispatchSubmission({
      text: '/rename',
      commands: localCommands(handlers({ onRename: async () => ({ type: ERenamed.Declined }) })),
      skills: [],
    })

    expect(dispatched.type).toBe(EDispatch.Refused)
    expect(dispatched.type === EDispatch.Refused && dispatched.reason).toContain('could not think of a name')
  })
})

describe('the compact command and its scope', () => {
  const commandsWith = (onCompact: (scope: ECompactScope) => void) =>
    localCommands(handlers({ onCompact }))

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
    const commands = localCommands(handlers({ onRewind: () => opened.push('rewind') }))

    await dispatchSubmission({ text: '/rewind', commands, skills: [], working: true })

    expect(opened).toEqual(['rewind'])
  })
})
