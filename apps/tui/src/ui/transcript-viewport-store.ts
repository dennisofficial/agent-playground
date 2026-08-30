import { useSyncExternalStore } from 'react'

export type TranscriptViewport = {
  tailing: boolean
  peekKey: string | null
}

export const AT_REST: TranscriptViewport = Object.freeze({
  tailing: true,
  peekKey: null,
})

const listeners = new Set<() => void>()

let current: TranscriptViewport = AT_REST

let version = 0

export const subscribeTranscriptViewport = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const transcriptViewportVersion = (): number => version

export const transcriptViewport = (): TranscriptViewport => current

export function applyTranscriptViewport(next: TranscriptViewport): void {
  if (next.tailing === current.tailing && next.peekKey === current.peekKey) return
  current = next
  version += 1
  for (const listener of listeners) listener()
}

export const resetTranscriptViewport = (): void => applyTranscriptViewport(AT_REST)

export function useTranscriptViewport(): TranscriptViewport {
  useSyncExternalStore(subscribeTranscriptViewport, transcriptViewportVersion)
  return transcriptViewport()
}
