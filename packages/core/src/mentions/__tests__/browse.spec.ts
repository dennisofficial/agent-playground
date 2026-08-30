import { describe, expect, it } from 'bun:test'

import {
  browseCandidates,
  completedMentionPath,
  splitMentionQuery,
  type DirectoryEntry,
} from '../browse'

const file = (name: string): DirectoryEntry => ({ name, isDirectory: false })
const folder = (name: string): DirectoryEntry => ({ name, isDirectory: true })

describe('splitMentionQuery', () => {
  it('reads a bare sigil as the directory the session started in', () => {
    expect(splitMentionQuery('')).toEqual({ directory: '', fragment: '' })
  })

  it('reads a name with no slash as a fragment of the starting directory', () => {
    expect(splitMentionQuery('app')).toEqual({ directory: '', fragment: 'app' })
  })

  it('reads a trailing slash as a directory with nothing typed under it', () => {
    expect(splitMentionQuery('apps/')).toEqual({ directory: 'apps/', fragment: '' })
  })

  it('splits a partly typed name from the directory holding it', () => {
    expect(splitMentionQuery('apps/tu')).toEqual({ directory: 'apps/', fragment: 'tu' })
  })

  it('keeps a deep directory whole', () => {
    expect(splitMentionQuery('apps/tui/src/comp')).toEqual({
      directory: 'apps/tui/src/',
      fragment: 'comp',
    })
  })

  it('reads a lone tilde as the home directory', () => {
    expect(splitMentionQuery('~')).toEqual({ directory: '~/', fragment: '' })
  })

  it('splits a path under home', () => {
    expect(splitMentionQuery('~/Developer/cub')).toEqual({
      directory: '~/Developer/',
      fragment: 'cub',
    })
  })

  it('reads a lone slash as the root of the filesystem', () => {
    expect(splitMentionQuery('/')).toEqual({ directory: '/', fragment: '' })
  })

  it('splits an absolute path', () => {
    expect(splitMentionQuery('/etc/ho')).toEqual({ directory: '/etc/', fragment: 'ho' })
  })

  it('keeps a climb out of the directory as part of the directory', () => {
    expect(splitMentionQuery('../sibling/re')).toEqual({
      directory: '../sibling/',
      fragment: 're',
    })
  })
})

describe('browseCandidates', () => {
  const level: readonly DirectoryEntry[] = [
    file('README.md'),
    folder('apps'),
    file('bun.lock'),
    folder('packages'),
    file('package.json'),
    folder('.scratch'),
    file('.gitignore'),
  ]

  const named = (fragment: string): readonly string[] =>
    browseCandidates({ entries: level, fragment }).map((entry) => entry.name)

  it('puts the directories above the files when nothing is typed', () => {
    expect(named('')).toEqual(['apps', 'packages', 'bun.lock', 'package.json', 'README.md'])
  })

  it('hides what a shell would hide until the dot is typed', () => {
    expect(named('')).not.toContain('.scratch')
    expect(named('.')).toEqual(['.scratch', '.gitignore'])
  })

  it('narrows to what the fragment starts', () => {
    expect(named('pack')).toEqual(['packages', 'package.json'])
  })

  it('ignores case', () => {
    expect(named('readme')).toEqual(['README.md'])
  })

  it('falls back to a fragment found anywhere in the name', () => {
    expect(named('lock')).toEqual(['bun.lock'])
  })

  it('prefers a name that starts with the fragment over one that merely holds it', () => {
    const entries = [file('my-app.ts'), file('app.ts')]
    expect(browseCandidates({ entries, fragment: 'app' }).map((one) => one.name)).toEqual([
      'app.ts',
      'my-app.ts',
    ])
  })
})

describe('completedMentionPath', () => {
  it('spells a file out under the directory it was found in', () => {
    expect(
      completedMentionPath({ directory: 'apps/tui/', entry: file('app.tsx') }),
    ).toEqual({ path: 'apps/tui/app.tsx', settled: true })
  })

  it('closes a directory with a slash and stays open for the next level', () => {
    expect(completedMentionPath({ directory: 'apps/', entry: folder('tui') })).toEqual({
      path: 'apps/tui/',
      settled: false,
    })
  })

  it('spells an entry of the starting directory without a leading slash', () => {
    expect(completedMentionPath({ directory: '', entry: file('CLAUDE.md') })).toEqual({
      path: 'CLAUDE.md',
      settled: true,
    })
  })

  it('keeps home spelled the way it was typed', () => {
    expect(completedMentionPath({ directory: '~/Developer/', entry: folder('atlas') })).toEqual({
      path: '~/Developer/atlas/',
      settled: false,
    })
  })
})
