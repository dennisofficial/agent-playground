import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EContextSlot, EInstructionFamily } from '@dltech/atlas-core'
import { beforeEach, describe, expect, it } from 'bun:test'

import { readInstructionFiles, readNestedInstructionFiles } from '../read-instructions'

let root: string

const write = ({ at, content }: { at: string; content: string }): string => {
  const path = join(root, at)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

const read = (args: {
  cwd?: string
  family?: EInstructionFamily
  userDirectories?: readonly string[]
  includeUser?: boolean
  includeProject?: boolean
  characterBudget?: number
}) =>
  readInstructionFiles({
    root,
    cwd: args.cwd ?? root,
    userDirectories: args.userDirectories ?? [],
    family: args.family ?? EInstructionFamily.Both,
    includeUser: args.includeUser ?? false,
    includeProject: args.includeProject ?? true,
    ...(args.characterBudget === undefined ? {} : { characterBudget: args.characterBudget }),
  })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atlas-instructions-'))
})

describe('readInstructionFiles', () => {
  it('reads nothing when the repository carries no instructions', async () => {
    expect(await read({})).toEqual([])
  })

  it('reads a root instruction file and labels it as project scope', async () => {
    const path = write({ at: 'CLAUDE.md', content: '# rules' })

    expect(await read({})).toEqual([
      { path, slot: EContextSlot.ProjectInstructions, content: '# rules' },
    ])
  })

  it('returns deeper files after shallower ones, so the deeper one wins', async () => {
    write({ at: 'CLAUDE.md', content: 'root' })
    write({ at: 'apps/CLAUDE.md', content: 'apps' })
    write({ at: 'apps/tui/CLAUDE.md', content: 'tui' })

    const loaded = await read({ cwd: join(root, 'apps/tui') })

    expect(loaded.map((entry) => entry.content)).toEqual(['root', 'apps', 'tui'])
  })

  it('reads the borrowed files before ATLAS.md in the same directory', async () => {
    write({ at: 'AGENTS.md', content: 'agents' })
    write({ at: 'CLAUDE.md', content: 'claude' })
    write({ at: 'ATLAS.md', content: 'atlas' })

    expect((await read({})).map((entry) => entry.content)).toEqual(['agents', 'claude', 'atlas'])
  })

  it('reads a local file after every shared file', async () => {
    write({ at: 'AGENTS.md', content: 'agents' })
    write({ at: 'CLAUDE.md', content: 'claude' })
    write({ at: 'ATLAS.md', content: 'atlas' })
    write({ at: 'CLAUDE.local.md', content: 'mine' })

    expect((await read({})).map((entry) => entry.content)).toEqual([
      'agents',
      'claude',
      'atlas',
      'mine',
    ])
  })

  it('reads ATLAS.md even when the borrowed families are switched off', async () => {
    write({ at: 'CLAUDE.md', content: 'claude' })
    write({ at: 'ATLAS.md', content: 'atlas' })

    expect((await read({ family: EInstructionFamily.None })).map((entry) => entry.content)).toEqual(
      ['atlas'],
    )
  })

  it('honours a narrowed family', async () => {
    write({ at: 'AGENTS.md', content: 'agents' })
    write({ at: 'CLAUDE.md', content: 'claude' })

    expect((await read({ family: EInstructionFamily.Agents })).map((entry) => entry.content)).toEqual([
      'agents',
    ])
  })

  it('labels a user-scope file with its own slot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'atlas-home-'))
    writeFileSync(join(home, 'ATLAS.md'), 'global')
    writeFileSync(join(home, 'CLAUDE.md'), 'borrowed')

    const loaded = await read({
      userDirectories: [home],
      includeUser: true,
      includeProject: false,
    })

    expect(loaded).toEqual([
      { path: join(home, 'ATLAS.md'), slot: EContextSlot.UserInstructions, content: 'global' },
    ])
  })

  it('skips a file that holds only whitespace, which has nothing to say', async () => {
    write({ at: 'CLAUDE.md', content: '   \n\n  ' })

    expect(await read({})).toEqual([])
  })

  it('skips a directory that happens to be named like an instruction file', async () => {
    mkdirSync(join(root, 'CLAUDE.md'), { recursive: true })

    expect(await read({})).toEqual([])
  })

  it('follows a symlinked instruction file rather than skipping it', async () => {
    writeFileSync(join(root, 'real.md'), 'linked')
    symlinkSync(join(root, 'real.md'), join(root, 'CLAUDE.md'))

    expect((await read({})).map((entry) => entry.content)).toEqual(['linked'])
  })

  it('stops loading once the character budget is spent, keeping the earlier files', async () => {
    write({ at: 'CLAUDE.md', content: 'a'.repeat(30) })
    write({ at: 'apps/CLAUDE.md', content: 'b'.repeat(30) })

    const loaded = await read({ cwd: join(root, 'apps'), characterBudget: 50 })

    expect(loaded.map((entry) => entry.content[0])).toEqual(['a'])
  })

  it('lets a later small file through when an earlier large one did not fit', async () => {
    write({ at: 'CLAUDE.md', content: 'a'.repeat(80) })
    write({ at: 'apps/CLAUDE.md', content: 'b' })

    const loaded = await read({ cwd: join(root, 'apps'), characterBudget: 50 })

    expect(loaded.map((entry) => entry.content)).toEqual(['b'])
  })
})

describe('readNestedInstructionFiles', () => {
  const readNested = (args: {
    cwd?: string
    touchedDirectory: string
    family?: EInstructionFamily
    characterBudget?: number
  }) =>
    readNestedInstructionFiles({
      root,
      cwd: args.cwd ?? root,
      touchedDirectory: args.touchedDirectory,
      family: args.family ?? EInstructionFamily.Both,
      ...(args.characterBudget === undefined ? {} : { characterBudget: args.characterBudget }),
    })

  it('labels the instruction file above a touched sibling path as nested scope', async () => {
    write({ at: 'CLAUDE.md', content: 'root' })
    const path = write({ at: 'packages/core/AGENTS.md', content: 'package rules' })

    const loaded = await readNested({
      cwd: join(root, 'apps/tui'),
      touchedDirectory: join(root, 'packages/core/src'),
    })

    expect(loaded).toEqual([
      { path, slot: EContextSlot.NestedInstructions, content: 'package rules' },
    ])
  })

  it('reads nothing for a touched path the project descent already covers', async () => {
    write({ at: 'CLAUDE.md', content: 'root' })

    expect(await readNested({ touchedDirectory: root })).toEqual([])
  })

  it('reads nothing when nothing above the touched path carries instructions', async () => {
    expect(await readNested({ touchedDirectory: join(root, 'packages/core') })).toEqual([])
  })

  it('returns shallower nested files before deeper ones, so the deeper one wins', async () => {
    write({ at: 'packages/AGENTS.md', content: 'packages' })
    write({ at: 'packages/core/AGENTS.md', content: 'core' })

    const loaded = await readNested({
      cwd: join(root, 'apps'),
      touchedDirectory: join(root, 'packages/core/src'),
    })

    expect(loaded.map((entry) => entry.content)).toEqual(['packages', 'core'])
  })

  it('spends the character budget across the nested files of one touch', async () => {
    write({ at: 'packages/AGENTS.md', content: 'a'.repeat(30) })
    write({ at: 'packages/core/AGENTS.md', content: 'b'.repeat(30) })

    const loaded = await readNested({
      cwd: join(root, 'apps'),
      touchedDirectory: join(root, 'packages/core'),
      characterBudget: 50,
    })

    expect(loaded.map((entry) => entry.content[0])).toEqual(['a'])
  })
})
