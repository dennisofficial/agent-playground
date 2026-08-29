import { ESidebarTaskState, type SidebarTask } from '../store/sidebar-model'
import { wrapCells } from './components/sidebar/cells'

export const TODO_MARK_CELLS = 2

export enum ETodoRow {
  Head = 'head',
  Continuation = 'continuation',
}

export type TodoRow = {
  key: string
  kind: ETodoRow
  text: string
  state: ESidebarTaskState
}

export function todoLabel(task: SidebarTask): string {
  if (task.state !== ESidebarTaskState.Running) return task.label

  return task.activeForm ?? task.label
}

function taskRows(args: { task: SidebarTask; cells: number }): TodoRow[] {
  return wrapCells({ text: todoLabel(args.task), cells: args.cells }).map((text, index) => ({
    key: `${args.task.id}:${index}`,
    kind: index === 0 ? ETodoRow.Head : ETodoRow.Continuation,
    text,
    state: args.task.state,
  }))
}

export function todoRows(args: { tasks: readonly SidebarTask[]; cells: number }): TodoRow[] {
  const room = Math.max(0, args.cells - TODO_MARK_CELLS)

  return args.tasks.flatMap((task) => taskRows({ task, cells: room }))
}
