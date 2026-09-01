import { keyboardItems, type FooterItem } from './footer-item'
import type { KeyPress } from './keys'

export type FooterStripState = { itemId: string }

export enum EStripCommand {
  Move = 'move',
  Activate = 'activate',
  Leave = 'leave',
  TypeThrough = 'type-through',
}

export type StripCommand =
  | { kind: EStripCommand.Move; delta: number }
  | { kind: EStripCommand.Activate }
  | { kind: EStripCommand.Leave }
  | { kind: EStripCommand.TypeThrough; text: string }

const CONTROL_CHARACTER = /[\u0000-\u001f]/

/**
 * A terminal sends DEL (0x7f) for Backspace and OpenTUI names the key without rewriting `sequence`
 * (its parser sets `name` alone for `s === "\x7F"`), so DEL reaches here looking every bit as
 * printable as a letter. Naming the keys that mean an edit is the reading that survives a terminal
 * spelling one of them with a byte the control range does not cover.
 */
const NEVER_TEXT: ReadonlySet<string> = new Set([
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'linefeed',
  'tab',
])

/**
 * The selection is an id rather than an index. The row is rebuilt every render and the drop ladder
 * sheds its tail when the terminal is dragged narrower, so an index would keep pointing somewhere
 * while quietly meaning a different pill.
 */
export function enterStrip(items: readonly FooterItem[]): FooterStripState | null {
  const [first] = keyboardItems(items)
  return first === undefined ? null : { itemId: first.id }
}

export function moveStripSelection(args: {
  state: FooterStripState
  items: readonly FooterItem[]
  delta: number
}): FooterStripState {
  const reachable = keyboardItems(args.items)
  const held = reachable.findIndex((item) => item.id === args.state.itemId)
  if (held < 0) return enterStrip(args.items) ?? args.state

  const wanted = held + Math.trunc(args.delta)
  const clamped = Math.min(Math.max(wanted, 0), reachable.length - 1)
  return { itemId: reachable[clamped]?.id ?? args.state.itemId }
}

export function reconcileStrip(args: {
  state: FooterStripState | null
  items: readonly FooterItem[]
}): FooterStripState | null {
  if (args.state === null) return null

  const still = keyboardItems(args.items).some((item) => item.id === args.state?.itemId)
  return still ? args.state : null
}

export function selectedStripItem(args: {
  state: FooterStripState | null
  items: readonly FooterItem[]
}): FooterItem | undefined {
  if (args.state === null) return undefined
  return keyboardItems(args.items).find((item) => item.id === args.state?.itemId)
}

export function stripCommand(key: KeyPress): StripCommand | null {
  if (key.name === 'left') return { kind: EStripCommand.Move, delta: -1 }
  if (key.name === 'right') return { kind: EStripCommand.Move, delta: 1 }
  if (key.name === 'return') return { kind: EStripCommand.Activate }
  if (key.name === 'escape' || key.name === 'up') return { kind: EStripCommand.Leave }

  if (key.name !== undefined && NEVER_TEXT.has(key.name)) return null

  const sequence = key.sequence ?? ''
  if (sequence.length === 0 || key.ctrl === true || key.meta === true) return null
  if (CONTROL_CHARACTER.test(sequence)) return null

  return { kind: EStripCommand.TypeThrough, text: sequence }
}
