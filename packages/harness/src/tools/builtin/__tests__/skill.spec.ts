import { describe, expect, it } from 'bun:test'

import { EToolEffect, toThreadId, type ToolOutcome } from '@dltech/atlas-core'

import { FakeSkillRegistry, fakeSkill } from '../../../prompt/__tests__/fake-skills'
import { SkillTool } from '../skill'

const CORPUS = [
  fakeSkill({
    name: 'research',
    description: 'Investigate a question against primary sources',
    body: 'Read references/method.md, then answer $ARGUMENTS.',
    directory: '/Users/dev/.claude/skills/research',
  }),
  fakeSkill({
    name: 'grilling',
    description: 'Stress-test a plan',
    directory: '/Users/dev/.claude/skills',
    entryPath: '/Users/dev/.claude/skills/grilling.md',
  }),
  fakeSkill({ name: 'daily-update', description: 'Post the standup', modelInvocable: false }),
  fakeSkill({ name: 'init', description: 'Write the project instructions' }),
]

const toolOver = (skills = CORPUS): SkillTool => new SkillTool(new FakeSkillRegistry({ skills }))

const invoke = (tool: SkillTool, input: unknown): Promise<ToolOutcome> =>
  tool.invoke({
    input,
    signal: AbortSignal.timeout(5_000),
    idempotencyKey: 'key-1',
    projectDirectory: '/Users/dev/project',
    threadId: toThreadId('thread-1'),
  })

describe('the skill tool as a declaration', () => {
  it('is named skill and reads the workspace rather than writing to it', () => {
    const tool = toolOver()

    expect(tool.name).toBe('skill')
    expect(tool.effect).toBe(EToolEffect.Read)
  })

  it('tells the model that a skill is packaged instructions it should reach for', () => {
    expect(toolOver().description).toContain('packaged')
  })
})

describe('loading a skill', () => {
  it('returns the skill body', async () => {
    const outcome = await invoke(toolOver(), { name: 'grilling' })

    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.modelText).toContain('Run the grilling procedure.')
  })

  it('prefixes the body with the directory the skill is installed in', async () => {
    const outcome = await invoke(toolOver(), { name: 'research' })

    expect(outcome.ok && outcome.modelText).toStartWith(
      'The research skill is installed at /Users/dev/.claude/skills/research.',
    )
  })

  it('says the relative paths in the body resolve beneath that directory', async () => {
    const outcome = await invoke(toolOver(), { name: 'research' })

    expect(outcome.ok && outcome.modelText).toContain('Every relative path below names a file')
  })

  it('names the root a flat single-file skill was found in, which is its only sane base', async () => {
    const outcome = await invoke(toolOver(), { name: 'grilling' })

    expect(outcome.ok && outcome.modelText).toStartWith(
      'The grilling skill is installed at /Users/dev/.claude/skills.',
    )
  })

  it('names no directory for a built-in skill, which lives nowhere on disk', async () => {
    const outcome = await invoke(toolOver(), { name: 'init' })

    expect(outcome.ok && outcome.modelText).toBe('Run the init procedure.')
  })

  it('expands the skill placeholders with the arguments it was given', async () => {
    const outcome = await invoke(toolOver(), {
      name: 'research',
      arguments: 'why the build is slow',
    })

    expect(outcome.ok && outcome.modelText).toContain('then answer why the build is slow.')
  })

  it('leaves the placeholder text empty when the call carries no arguments', async () => {
    const outcome = await invoke(toolOver(), { name: 'research' })

    expect(outcome.ok && outcome.modelText).toContain('then answer .')
  })

  it('matches the listed name regardless of how the model cased or padded it', async () => {
    const outcome = await invoke(toolOver(), { name: '  Grilling ' })

    expect(outcome.ok).toBe(true)
  })

  it('reports the resolved name, its files and the body a transcript can render', async () => {
    const outcome = await invoke(toolOver(), { name: 'research' })

    expect(outcome.ok && outcome.output).toEqual({
      name: 'research',
      directory: '/Users/dev/.claude/skills/research',
      path: '/Users/dev/.claude/skills/research/SKILL.md',
      text: 'Read references/method.md, then answer .',
      argumentText: '',
    })
  })

  it('carries the body without the directory preamble the model is given', async () => {
    const outcome = await invoke(toolOver(), { name: 'research' })
    const output = outcome.ok ? outcome.output : undefined

    expect(outcome.ok && outcome.modelText).toContain('/Users/dev/.claude/skills/research')
    expect(output).toMatchObject({ text: expect.not.stringContaining('is installed at') })
  })
})

describe('a skill the model may not invoke', () => {
  it('refuses one that sets disable-model-invocation', async () => {
    const outcome = await invoke(toolOver(), { name: 'daily-update' })

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain('disable-model-invocation')
  })

  it('leaks none of its body while refusing', async () => {
    const outcome = await invoke(toolOver(), { name: 'daily-update' })

    expect(!outcome.ok && outcome.reason).not.toContain('Run the daily-update procedure.')
  })

  it('does not offer it as a near miss for a name nobody has', async () => {
    const outcome = await invoke(toolOver(), { name: 'daily-updat' })

    expect(!outcome.ok && outcome.reason).not.toContain('daily-update')
  })
})

describe('a name that matches nothing', () => {
  it('fails rather than inventing a skill', async () => {
    const outcome = await invoke(toolOver(), { name: 'nothing-like-this-at-all' })

    expect(outcome.ok).toBe(false)
  })

  it('names the closest skill when the model mistyped one', async () => {
    const outcome = await invoke(toolOver(), { name: 'reserch' })

    expect(!outcome.ok && outcome.reason).toContain('research')
  })

  it('points back at the listing when nothing is close', async () => {
    const outcome = await invoke(toolOver(), { name: 'qqqqqqqqqqqqqqqq' })

    expect(!outcome.ok && outcome.reason).toContain('listing in your system prompt')
  })

  it('says so plainly when no skill is available at all', async () => {
    const outcome = await invoke(toolOver([]), { name: 'research' })

    expect(!outcome.ok && outcome.reason).toContain('none is available to you')
  })

  it('rejects an empty name at the schema rather than searching for it', async () => {
    const outcome = await invoke(toolOver(), { name: '' })

    expect(!outcome.ok && outcome.reason).toContain('invalid input')
  })
})
