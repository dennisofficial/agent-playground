import { EDefinitionOrigin, EToolEffect } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { parseAgentType, type AgentType } from '../agent-type'

const parse = (text: string, fallbackName = 'reviewer'): AgentType | undefined =>
  parseAgentType({ text, fallbackName, origin: EDefinitionOrigin.Project })

const frontmatter = (lines: readonly string[], body = 'Do the thing.'): string =>
  ['---', ...lines, '---', body].join('\n')

describe('parseAgentType', () => {
  it('maps description to whenToUse and the body to the prompt', () => {
    const parsed = parse(frontmatter(['description: Use me to review'], 'Review the diff.'))

    expect(parsed).toEqual({
      name: 'reviewer',
      whenToUse: 'Use me to review',
      prompt: 'Review the diff.',
      tools: undefined,
      disallowedTools: undefined,
      model: undefined,
      maxEffect: undefined,
      origin: EDefinitionOrigin.Project,
    })
  })

  it('names the agent type after the file when frontmatter does not', () => {
    expect(parse(frontmatter(['description: d']), 'deep-review')?.name).toBe('deep-review')
  })

  it('lowercases a frontmatter name so the model passes one spelling', () => {
    expect(parse(frontmatter(['name: Deep-Review', 'description: d']))?.name).toBe('deep-review')
  })

  it('splits tools and disallowed-tools on commas', () => {
    const parsed = parse(
      frontmatter(['description: d', 'tools: read, grep , glob', 'disallowed-tools: write,edit']),
    )

    expect(parsed?.tools).toEqual(['read', 'grep', 'glob'])
    expect(parsed?.disallowedTools).toEqual(['write', 'edit'])
  })

  it('reads a star tool list as inheriting every tool', () => {
    expect(parse(frontmatter(['description: d', 'tools: "*"']))?.tools).toBeUndefined()
  })

  it('reads an empty tool list as inheriting every tool rather than none', () => {
    expect(parse(frontmatter(['description: d', 'tools: " , "']))?.tools).toBeUndefined()
  })

  it('reads max-effect as the ceiling on what the agent type may do', () => {
    expect(parse(frontmatter(['description: d', 'max-effect: read']))?.maxEffect).toBe(
      EToolEffect.Read,
    )
    expect(parse(frontmatter(['description: d', 'max-effect: destructive']))?.maxEffect).toBe(
      EToolEffect.Destructive,
    )
  })

  it('skips a definition whose max-effect is not an effect, rather than silently uncapping it', () => {
    expect(parse(frontmatter(['description: d', 'max-effect: readonly']))).toBeUndefined()
    expect(parse(frontmatter(['description: d', 'max-effect: READ']))).toBeUndefined()
  })

  it('leaves the ceiling off when max-effect is absent', () => {
    expect(parse(frontmatter(['description: d']))?.maxEffect).toBeUndefined()
  })

  it('carries a pinned model through', () => {
    expect(parse(frontmatter(['description: d', 'model: haiku']))?.model).toBe('haiku')
  })

  it('skips a definition with no description, because that is how the model chooses one', () => {
    expect(parse(frontmatter(['name: reviewer']))).toBeUndefined()
    expect(parse(frontmatter(['description:    ']))).toBeUndefined()
  })

  it('skips a definition with no prompt body', () => {
    expect(parse(frontmatter(['description: d'], '   \n\n'))).toBeUndefined()
  })

  it('skips a definition with no frontmatter at all', () => {
    expect(parse('Just a prompt, no frontmatter.')).toBeUndefined()
  })

  it('skips an empty file', () => {
    expect(parse('   \n\n')).toBeUndefined()
  })

  it('skips a name the model could not pass verbatim', () => {
    expect(parse(frontmatter(['name: My Agent', 'description: d']))).toBeUndefined()
    expect(parse(frontmatter(['name: 1st', 'description: d']))).toBeUndefined()
    expect(parse(frontmatter(['description: d'], 'body'), 'notes copy')).toBeUndefined()
  })

  it('tolerates frontmatter keys it does not know', () => {
    expect(parse(frontmatter(['description: d', 'colour: green']))?.prompt).toBe('Do the thing.')
  })

  it('stamps the origin it was loaded from', () => {
    const parsed = parseAgentType({
      text: frontmatter(['description: d']),
      fallbackName: 'reviewer',
      origin: EDefinitionOrigin.User,
    })

    expect(parsed?.origin).toBe(EDefinitionOrigin.User)
  })
})
