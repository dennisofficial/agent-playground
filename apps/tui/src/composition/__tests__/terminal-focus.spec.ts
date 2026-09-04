import { EventEmitter } from 'node:events'

import { CliRenderEvents } from '@opentui/core'
import { afterEach, describe, expect, it } from 'bun:test'

import { applyTerminalFocus, ETerminalFocus, terminalFocus } from '../../ui/focus-store'
import { trackTerminalFocus } from '../terminal-focus'

afterEach(() => {
  applyTerminalFocus(ETerminalFocus.Unknown)
})

const harness = () => {
  const source = new EventEmitter()
  const written: string[] = []
  const teardown = trackTerminalFocus({
    source,
    write: (sequence) => written.push(sequence),
  })
  return { source, written, teardown }
}

describe('trackTerminalFocus', () => {
  it('enables focus reporting on track and disables it on teardown', () => {
    const { written, teardown } = harness()

    expect(written).toEqual(['\x1b[?1004h'])

    teardown()
    expect(written).toEqual(['\x1b[?1004h', '\x1b[?1004l'])
  })

  it('folds renderer focus and blur events into the store', () => {
    const { source, teardown } = harness()

    source.emit(CliRenderEvents.BLUR)
    expect(terminalFocus()).toBe(ETerminalFocus.Blurred)

    source.emit(CliRenderEvents.FOCUS)
    expect(terminalFocus()).toBe(ETerminalFocus.Focused)

    teardown()
  })

  it('resets to unknown and stops listening on teardown', () => {
    const { source, teardown } = harness()

    source.emit(CliRenderEvents.FOCUS)
    teardown()

    expect(terminalFocus()).toBe(ETerminalFocus.Unknown)

    source.emit(CliRenderEvents.BLUR)
    expect(terminalFocus()).toBe(ETerminalFocus.Unknown)
  })
})
