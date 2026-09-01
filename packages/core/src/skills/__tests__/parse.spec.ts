import { describe, expect, it } from 'bun:test'

import { parseYaml } from '../../yaml/parse'
import { skillFrontmatterOf } from '../parse'
import { ESkillContext, ESkillEffort, ESkillShell } from '../spec'

const readFrontmatter = (text: string, fallbackName = 'fallback') =>
  skillFrontmatterOf({ document: parseYaml(text), fallbackName })

describe('skillFrontmatterOf standard fields', () => {
  it('lowercases the declared name', () => {
    expect(readFrontmatter('name: Code-Review').name).toBe('code-review')
  })

  it('falls back to the directory name when no name is declared', () => {
    expect(readFrontmatter('description: a', 'my-skill').name).toBe('my-skill')
  })

  it('reads description, license and compatibility', () => {
    const frontmatter = readFrontmatter(
      'description: does a thing\nlicense: MIT\ncompatibility: any',
    )

    expect(frontmatter.description).toBe('does a thing')
    expect(frontmatter.license).toBe('MIT')
    expect(frontmatter.compatibility).toBe('any')
  })

  it('reads a description that holds its own colon', () => {
    expect(readFrontmatter('description: Use this skill when: the user asks').description).toBe(
      'Use this skill when: the user asks',
    )
  })

  it('reads metadata as a map of strings', () => {
    const frontmatter = readFrontmatter('metadata:\n  version: 2.0.0\n  author: dennis')

    expect(frontmatter.metadata.get('version')).toBe('2.0.0')
    expect(frontmatter.metadata.get('author')).toBe('dennis')
  })

  it('drops non-scalar metadata values', () => {
    const frontmatter = readFrontmatter('metadata:\n  tags:\n    - a\n  version: 1')

    expect([...frontmatter.metadata.keys()]).toEqual(['version'])
  })

  it('produces no metadata when metadata is not a map', () => {
    const frontmatter = readFrontmatter('metadata: just a string')

    expect(frontmatter.metadata.size).toBe(0)
    expect(frontmatter.unrecognised.get('metadata')).toBe('just a string')
  })
})

describe('skillFrontmatterOf tool lists', () => {
  it('reads a yaml list', () => {
    expect(readFrontmatter('allowed-tools:\n  - Read\n  - Write').allowedTools).toEqual([
      'Read',
      'Write',
    ])
  })

  it('reads a space separated string', () => {
    expect(readFrontmatter('allowed-tools: Read Write Edit').allowedTools).toEqual([
      'Read',
      'Write',
      'Edit',
    ])
  })

  it('reads a comma separated string', () => {
    expect(readFrontmatter('allowed-tools: Read, Write').allowedTools).toEqual(['Read', 'Write'])
  })

  it('keeps a parenthesised tool pattern intact', () => {
    expect(readFrontmatter('allowed-tools: Bash(git add:*), Read').allowedTools).toEqual([
      'Bash(git add:*)',
      'Read',
    ])
  })

  it('reads disallowed tools the same way', () => {
    expect(readFrontmatter('disallowed-tools: [Bash(rm:*), Write]').disallowedTools).toEqual([
      'Bash(rm:*)',
      'Write',
    ])
  })

  it('produces empty lists when no tools are declared', () => {
    const frontmatter = readFrontmatter('name: a')

    expect(frontmatter.allowedTools).toEqual([])
    expect(frontmatter.disallowedTools).toEqual([])
  })
})

describe('skillFrontmatterOf claude superset', () => {
  it('reads when_to_use and its hyphenated alias', () => {
    expect(readFrontmatter('when_to_use: after a rebase').whenToUse).toBe('after a rebase')
    expect(readFrontmatter('when-to-use: after a rebase').whenToUse).toBe('after a rebase')
  })

  it('reads the argument hint and argument names', () => {
    const frontmatter = readFrontmatter('argument-hint: <file>\narguments: source target')

    expect(frontmatter.argumentHint).toBe('<file>')
    expect(frontmatter.argumentNames).toEqual(['source', 'target'])
  })

  it('defaults invocability to user and model', () => {
    const frontmatter = readFrontmatter('name: a')

    expect(frontmatter.userInvocable).toBe(true)
    expect(frontmatter.modelInvocable).toBe(true)
  })

  it('reads the invocability flags', () => {
    const frontmatter = readFrontmatter('user-invocable: no\ndisable-model-invocation: yes')

    expect(frontmatter.userInvocable).toBe(false)
    expect(frontmatter.modelInvocable).toBe(false)
  })

  it('accepts every boolean spelling', () => {
    for (const written of ['false', 'no', 'off', '0', 'FALSE', 'No']) {
      expect(readFrontmatter(`user-invocable: ${written}`).userInvocable).toBe(false)
    }
    for (const written of ['true', 'yes', 'on', '1', 'TRUE', 'On']) {
      expect(readFrontmatter(`user-invocable: ${written}`).userInvocable).toBe(true)
    }
  })

  it('falls back to the default when a boolean is unreadable', () => {
    expect(readFrontmatter('user-invocable: maybe').userInvocable).toBe(true)
  })

  it('reads the model, effort, agent and background', () => {
    const frontmatter = readFrontmatter(
      'model: opus\neffort: XHigh\nagent: reviewer\nbackground: true',
    )

    expect(frontmatter.model).toBe('opus')
    expect(frontmatter.effort).toBe(ESkillEffort.XHigh)
    expect(frontmatter.agent).toBe('reviewer')
    expect(frontmatter.background).toBe(true)
  })

  it('leaves effort undefined when it is unrecognised', () => {
    expect(readFrontmatter('effort: gentle').effort).toBeUndefined()
  })

  it('leaves background undefined when it is absent', () => {
    expect(readFrontmatter('name: a').background).toBeUndefined()
  })

  it('reads the context, defaulting to inline', () => {
    expect(readFrontmatter('context: fork').context).toBe(ESkillContext.Fork)
    expect(readFrontmatter('name: a').context).toBe(ESkillContext.Inline)
    expect(readFrontmatter('context: nonsense').context).toBe(ESkillContext.Inline)
  })

  it('reads the shell, defaulting to bash', () => {
    expect(readFrontmatter('shell: powershell').shell).toBe(ESkillShell.PowerShell)
    expect(readFrontmatter('name: a').shell).toBe(ESkillShell.Bash)
  })

  it('reads paths as a comma separated string or a list', () => {
    expect(readFrontmatter('paths: src/**/*.ts, docs/*.md').paths).toEqual([
      'src/**/*.ts',
      'docs/*.md',
    ])
    expect(readFrontmatter('paths:\n  - src/a b.ts').paths).toEqual(['src/a b.ts'])
  })
})

describe('skillFrontmatterOf keeps what it cannot use', () => {
  it('keeps hooks rather than dropping them', () => {
    expect(readFrontmatter('hooks:\n  - on: stop').unrecognised.get('hooks')).toEqual(['on: stop'])
  })

  it('keeps any other unknown key verbatim', () => {
    const frontmatter = readFrontmatter('name: a\nfuture-field: whatever')

    expect(frontmatter.unrecognised.get('future-field')).toBe('whatever')
  })

  it('keeps nothing it did consume', () => {
    const frontmatter = readFrontmatter('name: a\ndescription: b\nmodel: opus\nshell: bash')

    expect(frontmatter.unrecognised.size).toBe(0)
  })
})

describe('skillFrontmatterOf argument hints', () => {
  it('keeps a bracketed hint as written rather than reading it as a list', () => {
    expect(readFrontmatter('argument-hint: [scope]').argumentHint).toBe('[scope]')
    expect(readFrontmatter('argument-hint: [source, target]').argumentHint).toBe('[source, target]')
  })

  it('leaves an empty hint undefined', () => {
    expect(readFrontmatter('argument-hint: []').argumentHint).toBeUndefined()
    expect(readFrontmatter('name: a').argumentHint).toBeUndefined()
  })
})
