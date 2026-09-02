import { describe, expect, it } from 'bun:test'

import {
  isMemoryIndexPath,
  looksLikeMemoryPath,
  memoryNameOf,
  mentionsMemoryPath,
} from '../recognise'

const GLOBAL = '/Users/d/.atlas/memory/git-trailers.md'
const PROJECT = '/Users/d/.atlas/projects/-Users-d-Developer-atlas/memory/bun-deflate.md'

describe('looksLikeMemoryPath', () => {
  it('recognises a memory under the global directory', () => {
    expect(looksLikeMemoryPath(GLOBAL)).toBe(true)
  })

  it('leaves a checkout that once held a development home alone', () => {
    expect(looksLikeMemoryPath('/Users/d/Developer/atlas/.atlas-home/memory/old.md')).toBe(false)
  })

  it('recognises a memory under a project directory', () => {
    expect(looksLikeMemoryPath(PROJECT)).toBe(true)
  })

  it('leaves a repository file in a folder called memory alone', () => {
    expect(looksLikeMemoryPath('/Users/d/code/app/src/memory/store.md')).toBe(false)
  })

  it('leaves a non-markdown file in the memory directory alone', () => {
    expect(looksLikeMemoryPath('/Users/d/.atlas/memory/notes.txt')).toBe(false)
  })

  it('leaves the memory directory itself alone', () => {
    expect(looksLikeMemoryPath('/Users/d/.atlas/memory')).toBe(false)
  })
})

describe('isMemoryIndexPath', () => {
  it('tells the index apart from a memory', () => {
    expect(isMemoryIndexPath('/Users/d/.atlas/memory/MEMORY.md')).toBe(true)
    expect(isMemoryIndexPath(GLOBAL)).toBe(false)
  })
})

describe('memoryNameOf', () => {
  it('names a memory by its file stem', () => {
    expect(memoryNameOf(PROJECT)).toBe('bun-deflate')
  })

  it('has no name for a path that is not a memory', () => {
    expect(memoryNameOf('/Users/d/code/README.md')).toBeUndefined()
  })
})

describe('mentionsMemoryPath', () => {
  it('sees a memory directory named in a shell line', () => {
    expect(mentionsMemoryPath('ls -la .atlas/memory')).toBe(true)
  })

  it('sees a project memory index behind a redirect', () => {
    expect(
      mentionsMemoryPath('cat .atlas/projects/-Users-d-code/memory/MEMORY.md 2>/dev/null'),
    ).toBe(true)
  })

  it('sees an absolute path under the real home', () => {
    expect(mentionsMemoryPath('rm /Users/d/.atlas/memory/old.md')).toBe(true)
  })

  it("does not mistake a repository's own memory module for one", () => {
    expect(mentionsMemoryPath('ls packages/core/src/memory')).toBe(false)
    expect(mentionsMemoryPath('cat src/memory/store.md')).toBe(false)
  })

  it('needs the directory that owns a memory directory, not the word alone', () => {
    expect(mentionsMemoryPath('echo memory')).toBe(false)
  })
})
