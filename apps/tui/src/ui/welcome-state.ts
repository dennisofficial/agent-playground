import type { TranscriptModel } from '../store'

const WELCOME_CELLS = 72

/**
 * The welcome screen is a state of the session rather than a block inside the transcript: nothing
 * has been said, so there is no transcript to scroll and no conversation for the sidebar to read.
 */
export function welcoming(args: { model: TranscriptModel; addressingChild: boolean }): boolean {
  const { model } = args
  return !args.addressingChild && model.isEmpty && !model.streaming && model.failure === null
}

export function welcomeCells(args: { width: number }): number {
  return Math.min(args.width, WELCOME_CELLS)
}
