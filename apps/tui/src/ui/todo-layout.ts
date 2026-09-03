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

export const TODO_DONE_TAIL = 2
export const TODO_FOLD_MIN = 2

export type TodoFold = {
  shown: readonly SidebarTask[]
  hidden: number
}

export function foldTodo(args: {
  tasks: readonly SidebarTask[]
  expanded: boolean
}): TodoFold {
  const completed = args.tasks.filter((task) => task.state === ESidebarTaskState.Done)
  const folded = completed.length - TODO_DONE_TAIL
  if (folded < TODO_FOLD_MIN) return { shown: args.tasks, hidden: 0 }

  const active = args.tasks.filter((task) => task.state !== ESidebarTaskState.Done)
  const hidden = completed.slice(0, folded)
  const tail = completed.slice(folded)

  return {
    shown: [...(args.expanded ? hidden : []), ...tail, ...active],
    hidden: hidden.length,
  }
}
