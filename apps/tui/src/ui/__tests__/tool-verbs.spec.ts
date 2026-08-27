import { describe, expect, it } from 'bun:test'

import { theme } from '../theme'
import {
  EToolVerb,
  EVerbTone,
  liveLabel,
  settledLabel,
  toneColour,
  verbIdentity,
  verbOfTool,
} from '../tool-verbs'

const readingOf = (name: string) => {
  const verb = verbOfTool(name)
  return [
    verb.spelling,
    settledLabel({ verb, count: 3 }),
    liveLabel(verb),
    verb.noun.many,
  ] as const
}

describe('a tool name the harness knows', () => {
  it('reads as a verb, a past-tense group, a live group and the noun it counts', () => {
    expect(readingOf('read')).toEqual(['read', 'Read 3 files', 'Reading files', 'files'])
    expect(readingOf('grep')).toEqual([
      'grep',
      'Searched 3 patterns',
      'Searching patterns',
      'patterns',
    ])
    expect(readingOf('edit')).toEqual(['edit', 'Edited 3 files', 'Editing files', 'files'])
    expect(readingOf('bash')).toEqual([
      'bash',
      'Ran 3 commands',
      'Running commands',
      'commands',
    ])
    expect(readingOf('write')).toEqual(['write', 'Wrote 3 files', 'Writing files', 'files'])
    expect(readingOf('glob')).toEqual([
      'glob',
      'Matched 3 patterns',
      'Matching patterns',
      'patterns',
    ])
    expect(readingOf('task')).toEqual(['task', 'Delegated 3 tasks', 'Delegating tasks', 'tasks'])
  })

  it('spells the noun singular when the group held one call', () => {
    expect(settledLabel({ verb: verbOfTool('read'), count: 1 })).toBe('Read 1 file')
    expect(settledLabel({ verb: verbOfTool('bash'), count: 1 })).toBe('Ran 1 command')
  })

  it('reads the same however the provider capitalised it, or padded it', () => {
    expect(verbOfTool('Read').verb).toBe(EToolVerb.Read)
    expect(verbOfTool('BASH').verb).toBe(EToolVerb.Bash)
    expect(verbOfTool('  Edit  ').verb).toBe(EToolVerb.Edit)
    expect(verbOfTool('Read_File').verb).toBe(EToolVerb.Read)
  })
})

describe('a tool name nothing recognises', () => {
  it('degrades to the name lowercased, counting bare calls', () => {
    const verb = verbOfTool('Frobnicate')

    expect(verb.verb).toBe(EToolVerb.Called)
    expect(verb.spelling).toBe('frobnicate')
    expect(verb.noun.many).toBe('calls')
    expect(settledLabel({ verb, count: 4 })).toBe('Called 4 × Frobnicate')
    expect(liveLabel(verb)).toBe('Calling Frobnicate')
  })

  it('keeps the name as written in the label, so it can still be looked up', () => {
    expect(settledLabel({ verb: verbOfTool('MyTool'), count: 1 })).toBe('Called 1 × MyTool')
  })

  it('is told apart from another unknown name, so two of them never share a group', () => {
    expect(verbIdentity(verbOfTool('alpha'))).not.toBe(verbIdentity(verbOfTool('beta')))
    expect(verbIdentity(verbOfTool('alpha'))).toBe(verbIdentity(verbOfTool('alpha')))
    expect(verbIdentity(verbOfTool('read'))).toBe(verbIdentity(verbOfTool('Read')))
  })
})

describe('a tool that reaches outside the repo', () => {
  it('marks any name carrying the MCP separator as external', () => {
    expect(verbOfTool('linear__createIssue').tone).toBe(EVerbTone.External)
    expect(settledLabel({ verb: verbOfTool('linear__createIssue'), count: 2 })).toBe(
      'Called 2 × linear__createIssue',
    )
  })

  it('stays external even when the segment after the separator looks like a verb it knows', () => {
    const verb = verbOfTool('remote__read')

    expect(verb.verb).toBe(EToolVerb.Called)
    expect(verb.tone).toBe(EVerbTone.External)
  })
})

describe('the colour a verb carries', () => {
  it('leaves a read-ish verb neutral, greens a mutation and sends an MCP call to the outside', () => {
    expect(toneColour(verbOfTool('read').tone)).toBe(theme.meta)
    expect(toneColour(verbOfTool('grep').tone)).toBe(theme.meta)
    expect(toneColour(verbOfTool('edit').tone)).toBe(theme.ok)
    expect(toneColour(verbOfTool('bash').tone)).toBe(theme.ok)
    expect(toneColour(verbOfTool('linear__createIssue').tone)).toBe(theme.court.external)
  })
})
