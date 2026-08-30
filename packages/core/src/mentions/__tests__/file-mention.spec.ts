import { describe, expect, it } from 'bun:test'

import {
  activeFilePathQuery,
  completedFilePath,
  fileMentionSpans,
  mentionedFilePaths,
  resolvedFileMentions,
} from '../file-mention'

const paths = (text: string): readonly string[] =>
  fileMentionSpans(text).map((mention) => mention.path)

describe('fileMentionSpans', () => {
  it('finds a mention at the start of the text', () => {
    expect(paths('@src/app.ts is the composition root')).toEqual(['src/app.ts'])
  })

  it('finds a mention in the middle of prose', () => {
    expect(paths('compare @src/app.ts with @docs/architecture.md please')).toEqual([
      'src/app.ts',
      'docs/architecture.md',
    ])
  })

  it('reads a bare filename', () => {
    expect(paths('@CLAUDE.md')).toEqual(['CLAUDE.md'])
  })

  it('reads a nested path with dashes and underscores', () => {
    expect(paths('@packages/core/src/my_file-name.ts')).toEqual([
      'packages/core/src/my_file-name.ts',
    ])
  })

  it('keeps a trailing slash so a directory can be named', () => {
    expect(paths('@packages/core/')).toEqual(['packages/core/'])
  })

  it('reports where the mention sits so the composer can paint it', () => {
    expect(fileMentionSpans('see @a/b.ts now')).toEqual([{ start: 4, end: 11, path: 'a/b.ts' }])
  })

  it('drops sentence punctuation glued to the end', () => {
    expect(paths('read @src/app.ts.')).toEqual(['src/app.ts'])
    expect(paths('read @src/app.ts, then stop')).toEqual(['src/app.ts'])
    expect(paths('is it @src/app.ts?')).toEqual(['src/app.ts'])
  })

  describe('is not fooled by addresses and decorations', () => {
    it('ignores an email address', () => {
      expect(paths('mail dennis@example.com about it')).toEqual([])
    })

    it('ignores an at glued to a preceding word', () => {
      expect(paths('npm i react@19')).toEqual([])
    })

    it('ignores a lone at', () => {
      expect(paths('what @ even is this')).toEqual([])
    })

    it('ignores a mention inside a code span', () => {
      expect(paths('write `@src/app.ts` in the prompt')).toEqual([])
    })

    it('ignores a decorator', () => {
      expect(paths('the @injectable() decorator')).toEqual(['injectable'])
    })
  })
})

describe('mentionedFilePaths', () => {
  it('reports the same path once however often it is named', () => {
    expect(mentionedFilePaths('@a.ts and @a.ts again')).toEqual(['a.ts'])
  })

  it('keeps the order they were first named in', () => {
    expect(mentionedFilePaths('@b.ts then @a.ts then @b.ts')).toEqual(['b.ts', 'a.ts'])
  })
})

describe('activeFilePathQuery', () => {
  it('reads the path being typed at the end of the composer', () => {
    expect(activeFilePathQuery('look at @src/ap')).toBe('src/ap')
  })

  it('reads an empty query the moment the at is typed', () => {
    expect(activeFilePathQuery('look at @')).toBe('')
  })

  it('is silent when nothing is being mentioned', () => {
    expect(activeFilePathQuery('look at src/app.ts')).toBeNull()
  })

  it('is silent once the mention is finished with a space', () => {
    expect(activeFilePathQuery('look at @src/app.ts ')).toBeNull()
  })

  it('is silent for an email address', () => {
    expect(activeFilePathQuery('mail dennis@exa')).toBeNull()
  })

  it('is silent inside a code span', () => {
    expect(activeFilePathQuery('`@src/ap')).toBeNull()
  })
})

describe('completedFilePath', () => {
  it('replaces the query being typed with the chosen path', () => {
    expect(completedFilePath({ text: 'look at @src/ap', path: 'src/app.ts' })).toBe(
      'look at @src/app.ts ',
    )
  })

  it('completes an empty query', () => {
    expect(completedFilePath({ text: '@', path: 'CLAUDE.md' })).toBe('@CLAUDE.md ')
  })

  it('leaves text alone when no mention is being typed', () => {
    expect(completedFilePath({ text: 'nothing here', path: 'a.ts' })).toBe('nothing here')
  })

  it('leaves the caret against a directory so the next level can be typed', () => {
    expect(completedFilePath({ text: 'read @app', path: 'apps/', settled: false })).toBe(
      'read @apps/',
    )
  })
})

describe('resolvedFileMentions', () => {
  const known = new Set(['src/app.ts', 'docs/architecture.md', 'packages/core/', 'docs'])

  const spans = (text: string): readonly string[] =>
    resolvedFileMentions({ text, known }).map((mention) => mention.path)

  it('keeps a mention that names a file the workspace has', () => {
    expect(spans('why is @src/app.ts broken')).toEqual(['src/app.ts'])
  })

  it('drops a mention that names nothing', () => {
    expect(spans('why is @src/absent.ts broken')).toEqual([])
  })

  it('keeps a mention that names a directory', () => {
    expect(spans('look through @packages/core/')).toEqual(['packages/core/'])
    expect(spans('look through @docs')).toEqual(['docs'])
  })

  it('drops a path the filesystem never confirmed', () => {
    expect(spans('read @packages/core/src/index.ts')).toEqual([])
  })

  it('drops a decorator that happens to look like a mention', () => {
    expect(spans('the @injectable() decorator')).toEqual([])
  })

  it('reports where the kept mention sits, sigil included', () => {
    expect(resolvedFileMentions({ text: 'see @src/app.ts', known })).toEqual([
      { start: 4, end: 15, path: 'src/app.ts' },
    ])
  })

  it('keeps every mention on a line that names several', () => {
    expect(spans('@src/app.ts and @docs/architecture.md and @nope.ts')).toEqual([
      'src/app.ts',
      'docs/architecture.md',
    ])
  })
})
