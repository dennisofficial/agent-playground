import { describe, expect, it } from 'bun:test'

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EDirectory, stateOfDirectory, workspaceRefusal } from '../workspace-directory'

describe('the state of the directory Atlas was pointed at', () => {
  it('reads a real directory as present', () => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-workspace-'))
    expect(stateOfDirectory(directory)).toBe(EDirectory.Present)
  })

  it('reads a file as something other than a directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-workspace-'))
    const file = join(directory, 'not-a-directory')
    writeFileSync(file, '')

    expect(stateOfDirectory(file)).toBe(EDirectory.NotADirectory)
  })

  it('reads an absent path as missing rather than throwing', () => {
    expect(stateOfDirectory(join(tmpdir(), 'atlas-workspace-absent-x9'))).toBe(EDirectory.Missing)
  })
})

describe('the refusal for a directory Atlas cannot work in', () => {
  it('has nothing to say about a directory that is there', () => {
    expect(workspaceRefusal({ directory: '/work', state: EDirectory.Present })).toBeNull()
  })

  it('names the directory it was given, because the operator typed it', () => {
    expect(workspaceRefusal({ directory: '/work/comp', state: EDirectory.Missing })).toBe(
      'Atlas cannot work in /work/comp: no such directory.',
    )
    expect(workspaceRefusal({ directory: '/work/file', state: EDirectory.NotADirectory })).toBe(
      'Atlas cannot work in /work/file: not a directory.',
    )
  })
})
