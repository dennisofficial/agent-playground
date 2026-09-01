import type { KeyEvent } from '@opentui/core'

const CONTROL = /[\u0000-\u001f]/

export const isPrintable = (key: KeyEvent): boolean => {
  const sequence = key.sequence ?? ''
  return sequence.length > 0 && !key.ctrl && !key.meta && !CONTROL.test(sequence)
}
