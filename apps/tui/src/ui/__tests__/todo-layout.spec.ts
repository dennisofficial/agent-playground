import { describe, expect, it } from 'bun:test'

import { ESidebarTaskState, type SidebarTask } from '../../store/sidebar-model'
import { ETodoRow, todoRows, TODO_MARK_CELLS } from '../todo-layout'

const CELLS = 20

const taskOf = (task: Partial<SidebarTask>): SidebarTask => ({
  id: '1',
  label: 'Ship it',
  state: ESidebarTaskState.Pending,
  ...task,
})

const rows = (tasks: readonly SidebarTask[], cells = CELLS) => todoRows({ tasks, cells })

describe('the rows a checklist lays out', () => {
  it('gives a short task one head row', () => {
    expect(rows([taskOf({})])).toEqual([
      { key: '1:0', kind: ETodoRow.Head, text: 'Ship it', state: ESidebarTaskState.Pending },
    ])
  })

  it('wraps a long task, marking only the first row as the head', () => {
    const laid = rows([taskOf({ label: 'Soft-wrap the sidebar task text' })])

    expect(laid.map((row) => [row.kind, row.text])).toEqual([
      [ETodoRow.Head, 'Soft-wrap the'],
      [ETodoRow.Continuation, 'sidebar task text'],
    ])
  })

  it('leaves room for the mark, so a wrapped row aligns under the label', () => {
    const laid = rows([taskOf({ label: 'a'.repeat(CELLS) })])

    expect(laid.map((row) => row.text.length)).toEqual([CELLS - TODO_MARK_CELLS, TODO_MARK_CELLS])
  })

  it('says the active form in place of the task that is running', () => {
    const laid = rows([
      taskOf({ state: ESidebarTaskState.Running, label: 'Fix it', activeForm: 'Fixing it' }),
    ])

    expect(laid.map((row) => row.text)).toEqual(['Fixing it'])
  })

  it('leaves the active form unsaid on a task that is not running', () => {
    const laid = rows([
      taskOf({ state: ESidebarTaskState.Done, label: 'Fix it', activeForm: 'Fixing it' }),
    ])

    expect(laid.map((row) => row.text)).toEqual(['Fix it'])
  })

  it('falls back to the task when a running one has no active form', () => {
    const laid = rows([taskOf({ state: ESidebarTaskState.Running, label: 'Fix it' })])

    expect(laid.map((row) => row.text)).toEqual(['Fix it'])
  })

  it('wraps a long active form the same as a long task', () => {
    const laid = rows([
      taskOf({
        state: ESidebarTaskState.Running,
        label: 'Fix it',
        activeForm: 'Fixing the thing that keeps on breaking',
      }),
    ])

    expect(laid.length).toBeGreaterThan(1)
    expect(laid.at(0)?.kind).toBe(ETodoRow.Head)
    expect(laid.slice(1).map((row) => row.kind)).not.toContain(ETodoRow.Head)
  })

  it('keys every row uniquely, so React never reuses one', () => {
    const laid = rows([
      taskOf({
        id: '1',
        state: ESidebarTaskState.Running,
        label: 'Soft-wrap the sidebar task text',
        activeForm: 'Soft-wrapping the sidebar task text here',
      }),
      taskOf({ id: '2', label: 'Another task entirely here' }),
    ])

    expect(new Set(laid.map((row) => row.key)).size).toBe(laid.length)
  })

  it('carries each task state onto its own rows', () => {
    const laid = rows([
      taskOf({ id: '1', label: 'Done thing', state: ESidebarTaskState.Done }),
      taskOf({ id: '2', label: 'Pending thing', state: ESidebarTaskState.Pending }),
    ])

    expect(laid.map((row) => row.state)).toEqual([ESidebarTaskState.Done, ESidebarTaskState.Pending])
  })

  it('lays out nothing for no tasks', () => {
    expect(rows([])).toEqual([])
  })
})
