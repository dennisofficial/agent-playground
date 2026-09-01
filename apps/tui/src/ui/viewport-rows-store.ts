import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()

let rows = 0

let top = 0

let version = 0

export const subscribeViewportRows = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const viewportRowsVersion = (): number => version

export const transcriptRows = (): number => rows

/** The screen row the transcript's viewport starts on. */
export const transcriptTop = (): number => top

export function applyTranscriptBounds(next: { top: number; rows: number }): void {
  const settledRows = Math.max(0, Math.floor(next.rows))
  const settledTop = Math.max(0, Math.floor(next.top))
  if (settledRows === rows && settledTop === top) return
  rows = settledRows
  top = settledTop
  version += 1
  for (const listener of listeners) listener()
}

export const applyTranscriptRows = (next: number): void =>
  applyTranscriptBounds({ top, rows: next })

/**
 * How many rows the transcript can actually show, which is not the terminal's height — the composer,
 * the footer and the peek line all take from it. A picture measured against the terminal instead can
 * come out taller than the box it lives in, and one that never fits is one that is always clipped.
 * Zero means nothing has measured it yet.
 */
export function useTranscriptRows(): number {
  useSyncExternalStore(subscribeViewportRows, viewportRowsVersion)
  return transcriptRows()
}
