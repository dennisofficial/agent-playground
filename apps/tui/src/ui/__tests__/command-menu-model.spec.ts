import { ECommandGroup, ECommandKind, type CommandSpec } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import {
  commandMenuWindow,
  completedText,
  moveCommandSelection,
  openCommandMenu,
  selectedCommand,
  type CommandMenuState,
} from '../command-menu-model'

const local = (args: {
  name: string
  summary: string
  argumentHint?: string
}): CommandSpec => ({
  name: args.name,
  kind: ECommandKind.Local,
  summary: args.summary,
  group: ECommandGroup.Session,
  ...(args.argumentHint === undefined ? {} : { argumentHint: args.argumentHint }),
})

const skill = (args: { name: string; summary: string }): CommandSpec => ({
  name: args.name,
  kind: ECommandKind.Skill,
  summary: args.summary,
  group: ECommandGroup.Workspace,
})

const SPECS: readonly CommandSpec[] = [
  local({ name: 'compact', summary: 'replace the history with a summary', argumentHint: '[all]' }),
  local({ name: 'clear', summary: 'start a fresh conversation' }),
  local({ name: 'model', summary: 'pick a model and an effort' }),
  skill({ name: 'review', summary: 'review the working tree' }),
  skill({ name: 'tdd', summary: 'drive the change from a failing test' }),
]

const namesOf = (state: CommandMenuState | null): readonly string[] =>
  state === null ? [] : state.matches.map((spec) => spec.name)

const opened = (text: string): CommandMenuState => {
  const state = openCommandMenu({ text, specs: SPECS })
  if (state === null) throw new Error(`expected the menu to open for ${JSON.stringify(text)}`)
  return state
}

describe('openCommandMenu', () => {
  it('opens on a token at offset 0 and selects the first match', () => {
    const state = opened('/c')

    expect(state.query).toBe('c')
    expect(state.index).toBe(0)
    expect(namesOf(state)).toEqual(['compact', 'clear'])
  })

  it('opens on a token typed mid-prose', () => {
    const state = opened('please run /rev')

    expect(state.query).toBe('rev')
    expect(namesOf(state)).toEqual(['review'])
  })

  it('lists every command for a bare slash', () => {
    const state = opened('/')

    expect(state.query).toBe('')
    expect(namesOf(state)).toEqual(SPECS.map((spec) => spec.name))
  })

  it('lists local commands and skills together', () => {
    expect(namesOf(opened('/'))).toContain('compact')
    expect(namesOf(opened('/'))).toContain('review')
  })

  it('closes when nothing matches the token', () => {
    expect(openCommandMenu({ text: '/zzz', specs: SPECS })).toBeNull()
  })

  it('closes when no token is being typed', () => {
    expect(openCommandMenu({ text: 'plain prose', specs: SPECS })).toBeNull()
  })

  it('closes once a space ends the token', () => {
    expect(openCommandMenu({ text: '/compact ', specs: SPECS })).toBeNull()
  })

  it('closes when a slash follows a non-space, so a path never opens it', () => {
    expect(openCommandMenu({ text: 'src/co', specs: SPECS })).toBeNull()
  })

  it('closes when the specs are empty', () => {
    expect(openCommandMenu({ text: '/c', specs: [] })).toBeNull()
  })
})

describe('moveCommandSelection', () => {
  it('moves down one match at a time', () => {
    const state = opened('/')

    expect(moveCommandSelection({ state, delta: 1 }).index).toBe(1)
  })

  it('wraps past the last match back to the first', () => {
    const state = { ...opened('/'), index: SPECS.length - 1 }

    expect(moveCommandSelection({ state, delta: 1 }).index).toBe(0)
  })

  it('wraps before the first match round to the last', () => {
    const state = opened('/')

    expect(moveCommandSelection({ state, delta: -1 }).index).toBe(SPECS.length - 1)
  })

  it('wraps a delta larger than the list', () => {
    const state = opened('/')

    expect(moveCommandSelection({ state, delta: SPECS.length + 2 }).index).toBe(2)
  })

  it('leaves the state alone for a zero delta', () => {
    const state = opened('/')

    expect(moveCommandSelection({ state, delta: 0 })).toBe(state)
  })

  it('keeps the query and the matches it was opened with', () => {
    const state = opened('/c')
    const moved = moveCommandSelection({ state, delta: 1 })

    expect(moved.query).toBe('c')
    expect(namesOf(moved)).toEqual(['compact', 'clear'])
  })
})

describe('selectedCommand', () => {
  it('answers the spec under the selection', () => {
    expect(selectedCommand(moveCommandSelection({ state: opened('/c'), delta: 1 }))?.name).toBe(
      'clear',
    )
  })

  it('answers null when the index names no match', () => {
    expect(selectedCommand({ index: 3, query: 'c', matches: [] })).toBeNull()
  })
})

describe('completedText', () => {
  const compact = local({ name: 'compact', summary: 'replace the history with a summary' })
  const review = skill({ name: 'review', summary: 'review the working tree' })

  it('completes a token at offset 0 and leaves a trailing space', () => {
    expect(completedText({ text: '/comp', spec: compact })).toBe('/compact ')
  })

  it('completes a bare slash', () => {
    expect(completedText({ text: '/', spec: compact })).toBe('/compact ')
  })

  it('completes mid-prose, keeping the words before the token', () => {
    expect(completedText({ text: 'write the tests then /rev', spec: review })).toBe(
      'write the tests then /review ',
    )
  })

  it('replaces only the token, never an earlier mention of the same name', () => {
    expect(completedText({ text: '/review then /rev', spec: review })).toBe('/review then /review ')
  })

  it('returns the text untouched when no token is being typed', () => {
    expect(completedText({ text: 'nothing to complete', spec: compact })).toBe(
      'nothing to complete',
    )
  })
})

describe('commandMenuWindow', () => {
  it('shows every match when they fit', () => {
    const { start, visible } = commandMenuWindow({ state: opened('/'), rows: 8 })

    expect(start).toBe(0)
    expect(visible).toHaveLength(SPECS.length)
  })

  it('holds the top of the list while the selection is inside the window', () => {
    const state = { ...opened('/'), index: 1 }
    const { start, visible } = commandMenuWindow({ state, rows: 2 })

    expect(start).toBe(0)
    expect(visible.map((spec) => spec.name)).toEqual(['compact', 'clear'])
  })

  it('scrolls so a selection below the window stays visible', () => {
    const state = { ...opened('/'), index: 4 }
    const { start, visible } = commandMenuWindow({ state, rows: 2 })

    expect(start).toBe(3)
    expect(visible.map((spec) => spec.name)).toEqual(['review', 'tdd'])
  })

  it('never scrolls past the end of the list', () => {
    const state = { ...opened('/'), index: SPECS.length - 1 }

    expect(commandMenuWindow({ state, rows: 3 }).visible).toHaveLength(3)
  })

  it('shows at least one row for a degenerate height', () => {
    expect(commandMenuWindow({ state: opened('/'), rows: 0 }).visible).toHaveLength(1)
  })
})
