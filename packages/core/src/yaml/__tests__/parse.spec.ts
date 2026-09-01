import { describe, expect, it } from 'bun:test'

import { parseFrontmatter, parseYaml } from '../parse'
import { isYamlList, isYamlMap } from '../value'

describe('parseYaml scalars', () => {
  it('reads a key and its value', () => {
    expect(parseYaml('name: advisor').get('name')).toBe('advisor')
  })

  it('strips matched surrounding quotes', () => {
    expect(parseYaml('name: "advisor"').get('name')).toBe('advisor')
    expect(parseYaml("name: 'advisor'").get('name')).toBe('advisor')
  })

  it('splits on the first colon only', () => {
    const document = parseYaml('description: Use this skill when: the user asks for a review')

    expect(document.get('description')).toBe('Use this skill when: the user asks for a review')
  })

  it('keeps a url intact', () => {
    expect(parseYaml('link: see https://x.com/a').get('link')).toBe('see https://x.com/a')
  })

  it('drops a whole-line comment and a trailing comment', () => {
    const document = parseYaml('# leading\nname: advisor # the name\n\nmodel: opus')

    expect(document.get('name')).toBe('advisor')
    expect(document.get('model')).toBe('opus')
  })

  it('keeps a hash that is inside quotes or inside a word', () => {
    expect(parseYaml('name: "a # b"').get('name')).toBe('a # b')
    expect(parseYaml('link: https://x.com/a#b').get('link')).toBe('https://x.com/a#b')
  })

  it('reads an empty value as an empty string', () => {
    expect(parseYaml('name:\nmodel: opus').get('name')).toBe('')
  })
})

describe('parseYaml lists', () => {
  it('reads an indented block list', () => {
    const value = parseYaml('allowed-tools:\n  - Read\n  - Bash(git:*)\nmodel: opus')

    expect(value.get('allowed-tools')).toEqual(['Read', 'Bash(git:*)'])
    expect(value.get('model')).toBe('opus')
  })

  it('reads a block list written at the parent indent', () => {
    expect(parseYaml('tools:\n- Read\n- Write').get('tools')).toEqual(['Read', 'Write'])
  })

  it('reads an inline flow list', () => {
    expect(parseYaml('tools: [Read, "Write", Bash(git:*)]').get('tools')).toEqual([
      'Read',
      'Write',
      'Bash(git:*)',
    ])
  })

  it('reads an empty flow list', () => {
    const value = parseYaml('tools: []').get('tools')

    expect(isYamlList(value) && value.length).toBe(0)
  })
})

describe('parseYaml nested maps', () => {
  it('reads one level of nesting', () => {
    const metadata = parseYaml('metadata:\n  version: 2.0.0\n  author: dennis\nname: a').get(
      'metadata',
    )

    expect(isYamlMap(metadata) && metadata.get('version')).toBe('2.0.0')
    expect(isYamlMap(metadata) && metadata.get('author')).toBe('dennis')
  })

  it('reads two levels of nesting', () => {
    const outer = parseYaml('metadata:\n  build:\n    tag: v1\n').get('metadata')
    const inner = isYamlMap(outer) ? outer.get('build') : undefined

    expect(isYamlMap(inner) && inner.get('tag')).toBe('v1')
  })

  it('returns to the outer map after a nested map ends', () => {
    const document = parseYaml('metadata:\n  version: 1\nname: advisor')

    expect(document.get('name')).toBe('advisor')
  })

  it('reads a list nested under a nested map', () => {
    const outer = parseYaml('metadata:\n  tags:\n    - a\n    - b').get('metadata')

    expect(isYamlMap(outer) && outer.get('tags')).toEqual(['a', 'b'])
  })
})

describe('parseYaml block scalars', () => {
  it('keeps newlines in a literal block', () => {
    expect(parseYaml('body: |\n  one\n  two\nname: a').get('body')).toBe('one\ntwo\n')
  })

  it('strips the trailing newline when asked', () => {
    expect(parseYaml('body: |-\n  one\n  two').get('body')).toBe('one\ntwo')
  })

  it('folds a folded block with spaces', () => {
    expect(parseYaml('body: >\n  one\n  two\n\n  three').get('body')).toBe('one two\nthree\n')
  })

  it('strips the block indentation', () => {
    expect(parseYaml('body: |\n    one\n      two').get('body')).toBe('one\n  two\n')
  })

  it('reads the key that follows a block', () => {
    expect(parseYaml('body: |\n  one\n\nname: advisor').get('name')).toBe('advisor')
  })
})

describe('parseYaml degrades', () => {
  it('skips a line it cannot read and keeps the rest', () => {
    const document = parseYaml('name: advisor\njust some prose\nmodel: opus')

    expect(document.get('name')).toBe('advisor')
    expect(document.get('model')).toBe('opus')
  })

  it('returns an empty map for empty text', () => {
    expect(parseYaml('').size).toBe(0)
    expect(parseYaml('\n\n# only a comment\n').size).toBe(0)
  })
})

describe('parseFrontmatter', () => {
  it('parses the fenced document and returns the body', () => {
    const { document, body } = parseFrontmatter('---\nname: advisor\n---\nBody here')

    expect(document.get('name')).toBe('advisor')
    expect(body).toBe('Body here')
  })

  it('strips leading blank lines from the body', () => {
    expect(parseFrontmatter('---\nname: a\n---\n\n\nBody').body).toBe('Body')
  })

  it('returns the whole text as body when there is no opening fence', () => {
    const { document, body } = parseFrontmatter('Just a body')

    expect(document.size).toBe(0)
    expect(body).toBe('Just a body')
  })

  it('returns the whole text as body when the fence never closes', () => {
    const text = '---\nname: broken\nstill going'

    expect(parseFrontmatter(text).body).toBe(text)
    expect(parseFrontmatter(text).document.size).toBe(0)
  })
})
