import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()

let covered = false

let version = 0

export const subscribeCovered = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const coveredVersion = (): number => version

export const transcriptCovered = (): boolean => covered

export function applyTranscriptCovered(next: boolean): void {
  if (next === covered) return
  covered = next
  version += 1
  for (const listener of listeners) listener()
}

/**
 * Whether something is painted over the transcript.
 *
 * A terminal drawing a kitty image composites it over the whole text plane, ignoring the z-order the
 * cell renderer drew in, so a picture in the transcript shows straight through any overlay above it.
 * Nothing can be layered over an image; it can only be withheld.
 */
export function useTranscriptCovered(): boolean {
  useSyncExternalStore(subscribeCovered, coveredVersion)
  return transcriptCovered()
}
