import type { DirectoryEntry } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import {
  completedMention,
  fileMenuWindow,
  mentionQueryOf,
  moveFileSelection,
  openFileMenu,
  pathOfEntry,
  selectedEntry,
  type FileMenuState,
} from '../file-menu-model'

const file = (name: string): DirectoryEntry => ({ name, isDirectory: false })
const folder = (name: string): DirectoryEntry => ({ name, isDirectory: true })

const LEVEL: readonly DirectoryEntry[] = [folder('apps'), folder('packages'), file('README.md')]

const opened = (args: {
  text: string
  entries?: readonly DirectoryEntry[]
}): FileMenuState | null => {
  const query = mentionQueryOf(args.text)
  if (query === null) return null
  return openFileMenu({ query, entries: args.entries ?? LEVEL })
}

const menuFor = (args: { text: string; entries?: readonly DirectoryEntry[] }): FileMenuState => {
  const state = opened(args)
  if (state === null) throw new Error('expected an open menu')
  return state
}

describe('mentionQueryOf', () => {
  it('says nothing is being mentioned in ordinary prose', () => {
    expect(mentionQueryOf('fix the build')).toBeNull()
  })

  it('reads a bare sigil as the starting directory', () => {
    expect(mentionQueryOf('look at @')).toEqual({ directory: '', fragment: '' })
  })

  it('reads a directory the developer has stepped into', () => {
    expect(mentionQueryOf('look at @apps/tui/')).toEqual({ directory: 'apps/tui/', fragment: '' })
  })

  it('reads a path under home', () => {
    expect(mentionQueryOf('look at @~/Developer/cub')).toEqual({
      directory: '~/Developer/',
      fragment: 'cub',
    })
  })
})

describe('openFileMenu', () => {
  it('shows the level a bare sigil opens on', () => {
    expect(menuFor({ text: 'read @' }).matches).toEqual([
      folder('apps'),
      folder('packages'),
      file('README.md'),
    ])
  })

  it('narrows the level to what has been typed under it', () => {
    expect(menuFor({ text: 'read @app' }).matches).toEqual([folder('apps')])
  })

  it('carries the directory it is listing', () => {
    expect(menuFor({ text: 'read @apps/tui/', entries: [file('app.tsx')] }).directory).toBe(
      'apps/tui/',
    )
  })

  it('stays shut when the level holds nothing that matches', () => {
    expect(opened({ text: 'read @zzz' })).toBeNull()
  })

  it('stays shut when the level is empty', () => {
    expect(opened({ text: 'read @absent/', entries: [] })).toBeNull()
  })
})

describe('selectedEntry', () => {
  it('names the entry under the caret', () => {
    const state = menuFor({ text: 'read @' })
    expect(selectedEntry(moveFileSelection({ state, delta: 1 }))).toEqual(folder('packages'))
  })
})

describe('pathOfEntry', () => {
  it('spells a file under the directory it was listed in', () => {
    expect(pathOfEntry({ directory: 'apps/', entry: file('app.tsx') })).toBe('apps/app.tsx')
  })

  it('closes a directory with a slash', () => {
    expect(pathOfEntry({ directory: 'apps/', entry: folder('tui') })).toBe('apps/tui/')
  })
})

describe('completedMention', () => {
  it('settles a file with a space, so the message can go on', () => {
    const text = 'read @READ'
    expect(completedMention({ text, state: menuFor({ text }) })).toBe('read @README.md ')
  })

  it('leaves a directory open, so the next level can be walked into', () => {
    const text = 'read @app'
    expect(completedMention({ text, state: menuFor({ text }) })).toBe('read @apps/')
  })

  it('keeps the directory already walked into', () => {
    const text = 'read @apps/t'
    const state = menuFor({ text, entries: [folder('tui')] })
    expect(completedMention({ text, state })).toBe('read @apps/tui/')
  })
})

describe('fileMenuWindow', () => {
  it('shows everything that fits', () => {
    expect(fileMenuWindow({ state: menuFor({ text: 'read @' }), rows: 8 })).toEqual({
      start: 0,
      visible: LEVEL,
    })
  })

  it('scrolls to keep the selection in view', () => {
    const state = menuFor({ text: 'read @' })

    expect(fileMenuWindow({ state: { ...state, index: 2 }, rows: 2 })).toEqual({
      start: 1,
      visible: [folder('packages'), file('README.md')],
    })
  })
})
