import { describe, expect, it } from 'bun:test'

import { activeQuery, commandCandidates, resolveSubmission } from '../resolve'
import { ECommandGroup, ECommandKind, type CommandSpec } from '../spec'

const skill = (name: string): CommandSpec => ({
  name,
  kind: ECommandKind.Skill,
  summary: name,
  group: ECommandGroup.Workspace,
})

const local = (name: string, aliases?: readonly string[]): CommandSpec => ({
  name,
  aliases,
  kind: ECommandKind.Local,
  summary: name,
  group: ECommandGroup.Session,
})

const SPECS = [local('compact'), local('rewind'), skill('review'), skill('tdd'), skill('implement')]

const resolve = (text: string) => resolveSubmission({ text, specs: SPECS })

describe('resolveSubmission', () => {
  it('sends plain prose as prose', () => {
    expect(resolve('please fix the build')).toEqual({ local: null, skills: [] })
  })

  it('sends an unknown command as prose', () => {
    expect(resolve('/nosuchthing please')).toEqual({ local: null, skills: [] })
  })

  it('runs a local command with the rest of the line as its arguments', () => {
    const submission = resolve('/compact everything')

    expect(submission.local?.spec.name).toBe('compact')
    expect(submission.local?.argumentText).toBe('everything')
    expect(submission.skills).toEqual([])
  })

  it('loads a leading skill and hands it the rest of the line', () => {
    const submission = resolve('/review src/auth.ts')

    expect(submission.local).toBeNull()
    expect(submission.skills.map((one) => one.spec.name)).toEqual(['review'])
    expect(submission.skills[0]?.argumentText).toBe('src/auth.ts')
  })

  it('chains leading skills, giving each the same arguments', () => {
    const submission = resolve('/tdd /implement do X')

    expect(submission.skills.map((one) => one.spec.name)).toEqual(['tdd', 'implement'])
    expect(submission.skills.every((one) => one.argumentText === 'do X')).toBe(true)
  })

  it('loads a skill mentioned mid-prose and hands it the whole message', () => {
    const text = 'please use /tdd for this'
    const submission = resolveSubmission({ text, specs: SPECS })

    expect(submission.skills.map((one) => one.spec.name)).toEqual(['tdd'])
    expect(submission.skills[0]?.argumentText).toBe(text)
  })

  it('ignores a mention inside backticks', () => {
    expect(resolve('type `/tdd` to begin').skills).toEqual([])
  })

  it('loads a skill only once however often it is named', () => {
    expect(resolve('/tdd use /tdd again').skills.map((one) => one.spec.name)).toEqual(['tdd'])
  })

  it('lets a local command consume the line rather than chaining skills onto it', () => {
    const submission = resolve('/compact /tdd')

    expect(submission.local?.spec.name).toBe('compact')
    expect(submission.skills).toEqual([])
  })

  it('resolves a qualified name', () => {
    expect(resolve('/skill:review').skills.map((one) => one.spec.name)).toEqual(['review'])
  })

  it('gives a skill the bare name when a local command shares it', () => {
    const clash = [local('review'), skill('review')]
    const submission = resolveSubmission({ text: '/review', specs: clash })

    expect(submission.local).toBeNull()
    expect(submission.skills.map((one) => one.spec.name)).toEqual(['review'])
  })

  it('still reaches the shadowed local command through its qualifier', () => {
    const clash = [local('review'), skill('review')]

    expect(resolveSubmission({ text: '/local:review', specs: clash }).local?.spec.name).toBe('review')
  })

  it('runs a local command through one of its aliases', () => {
    const submission = resolveSubmission({ text: '/clear', specs: [local('new', ['clear'])] })

    expect(submission.local?.spec.name).toBe('new')
    expect(submission.skills).toEqual([])
  })

  it('hands an alias the rest of the line, like the name would', () => {
    const submission = resolveSubmission({ text: '/clear later', specs: [local('new', ['clear'])] })

    expect(submission.local?.spec.name).toBe('new')
    expect(submission.local?.argumentText).toBe('later')
  })

  it('lets a real name win over another command\'s alias', () => {
    const specs = [local('new', ['restart']), local('restart')]

    expect(resolveSubmission({ text: '/restart', specs }).local?.spec.name).toBe('restart')
  })
})

describe('activeQuery', () => {
  it('reads the token being typed at the start', () => {
    expect(activeQuery('/rev')).toBe('rev')
  })

  it('reads the token being typed mid-prose', () => {
    expect(activeQuery('please use /td')).toBe('td')
  })

  it('is empty for a bare slash', () => {
    expect(activeQuery('/')).toBe('')
  })

  it('is null once the token is finished', () => {
    expect(activeQuery('/review ')).toBeNull()
  })

  it('is null inside a path', () => {
    expect(activeQuery('src/rev')).toBeNull()
  })
})

describe('commandCandidates', () => {
  it('lists everything for a bare slash', () => {
    expect(commandCandidates({ text: '/', specs: SPECS })).toHaveLength(5)
  })

  it('filters by prefix', () => {
    expect(commandCandidates({ text: '/re', specs: SPECS }).map((one) => one.name)).toEqual([
      'rewind',
      'review',
    ])
  })

  it('matches a word inside a hyphenated name', () => {
    const specs = [skill('code-review')]

    expect(commandCandidates({ text: '/rev', specs }).map((one) => one.name)).toEqual(['code-review'])
  })

  it('matches an alias, returning the command it belongs to once', () => {
    const specs = [local('new', ['clear'])]

    expect(commandCandidates({ text: '/cle', specs }).map((one) => one.name)).toEqual(['new'])
  })

  it('matches an alias on a word inside it', () => {
    const specs = [local('new', ['fresh-conversation'])]

    expect(commandCandidates({ text: '/conv', specs }).map((one) => one.name)).toEqual(['new'])
  })

  it('lists nothing when no token is being typed', () => {
    expect(commandCandidates({ text: 'hello', specs: SPECS })).toEqual([])
  })
})
