import { CliRenderEvents } from '@opentui/core'

import { applyTerminalFocus, ETerminalFocus } from '../ui/focus-store'

export type FocusEventSource = {
  on(event: CliRenderEvents, listener: () => void): void
  off(event: CliRenderEvents, listener: () => void): void
}

const ENABLE_FOCUS_REPORTING = '\x1b[?1004h'
const DISABLE_FOCUS_REPORTING = '\x1b[?1004l'

// https://github.com/anomalyco/opentui/issues/1333 — opentui gates mode 1004 on a DECRQM answer
// and never enables it on terminals that report focus but stay quiet on the query (this one
// included), so the mode is enabled from here. The renderer's parser dispatches FOCUS/BLUR
// whether or not it set the mode itself.
export function trackTerminalFocus(args: {
  source: FocusEventSource
  write: (sequence: string) => void
}): () => void {
  const handleFocus = (): void => applyTerminalFocus(ETerminalFocus.Focused)
  const handleBlur = (): void => applyTerminalFocus(ETerminalFocus.Blurred)

  args.source.on(CliRenderEvents.FOCUS, handleFocus)
  args.source.on(CliRenderEvents.BLUR, handleBlur)
  args.write(ENABLE_FOCUS_REPORTING)

  return () => {
    args.source.off(CliRenderEvents.FOCUS, handleFocus)
    args.source.off(CliRenderEvents.BLUR, handleBlur)
    args.write(DISABLE_FOCUS_REPORTING)
    applyTerminalFocus(ETerminalFocus.Unknown)
  }
}
