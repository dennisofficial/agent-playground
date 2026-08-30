import { describe, expect, it } from 'bun:test'

import { shortenPath } from '../path-shorten'

const spelled = (args: { path: string; cells: number }): string => {
  const short = shortenPath(args)
  return `${short.directory}${short.name}`
}

describe('shortenPath', () => {
  it('leaves a path that fits exactly as it is', () => {
    expect(shortenPath({ path: 'src/app.tsx', cells: 40 })).toEqual({
      directory: 'src/',
      name: 'app.tsx',
    })
  })

  it('reports a bare file name as having no directory', () => {
    expect(shortenPath({ path: 'CLAUDE.md', cells: 40 })).toEqual({
      directory: '',
      name: 'CLAUDE.md',
    })
  })

  it('keeps a trailing slash on a directory it was handed', () => {
    expect(shortenPath({ path: 'packages/core/', cells: 40 })).toEqual({
      directory: 'packages/',
      name: 'core/',
    })
  })

  it('shrinks the outermost directory first', () => {
    expect(spelled({ path: 'packages/core/src/mentions/file-mention.ts', cells: 36 })).toBe(
      'p/core/src/mentions/file-mention.ts',
    )
  })

  it('keeps shrinking inwards until the path fits', () => {
    expect(spelled({ path: 'packages/core/src/mentions/file-mention.ts', cells: 30 })).toBe(
      'p/c/s/mentions/file-mention.ts',
    )
  })

  it('spends every outer directory before the one holding the file', () => {
    const short = shortenPath({ path: 'packages/core/src/mentions/file-mention.ts', cells: 30 })
    expect(short.name).toBe('file-mention.ts')
    expect(short.directory).toEndWith('mentions/')
  })

  it('gives up the folder holding the file only when nothing else is left', () => {
    const short = shortenPath({ path: 'packages/core/src/mentions/file-mention.ts', cells: 24 })
    expect(short.name).toBe('file-mention.ts')
    expect(short.directory).not.toContain('mentions')
  })

  it('keeps enough of a hidden directory to tell it apart from the dot', () => {
    expect(spelled({ path: '.scratch/thread-management/spec.md', cells: 28 })).toBe(
      '.s/thread-management/spec.md',
    )
  })

  it('drops the head of a path that cannot fit even shortened', () => {
    const spelledOut = spelled({ path: 'a/b/c/d/e/f/g/h/i/deep-file-name.ts', cells: 24 })
    expect(spelledOut).toStartWith('…/')
    expect(spelledOut).toEndWith('deep-file-name.ts')
  })

  it('truncates a file name that cannot fit on its own', () => {
    expect(spelled({ path: 'src/an-extremely-long-file-name.ts', cells: 10 })).toBe('an-extrem…')
  })
})
