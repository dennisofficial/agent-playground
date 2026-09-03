import { settled } from './tool-runs'
import { EEntryKind, type TranscriptEntry } from './transcript-model'

export function isExpandable(entry: TranscriptEntry): boolean {
  if (entry.kind === EEntryKind.ModelThought) {
    return !entry.streaming && !entry.heldOpen && entry.text.length > 0
  }
  if (entry.kind === EEntryKind.ToolsRan) {
    return entry.run.calls.length > 0 && entry.run.calls.every(settled)
  }
  if (entry.kind === EEntryKind.BackgroundShellEnded) return entry.output.trimEnd().length > 0
  if (entry.kind === EEntryKind.BackgroundShellAwaitingInput) {
    return entry.output.trimEnd().length > 0
  }
  if (entry.kind === EEntryKind.BackgroundShellMatched) return entry.output.trimEnd().length > 0
  if (entry.kind === EEntryKind.ServiceEnded) return entry.output.trimEnd().length > 0
  if (entry.kind === EEntryKind.AgentEnded) return entry.report.trim().length > 0
  if (entry.kind === EEntryKind.HistoryCompacted) return entry.text.trim().length > 0
  return false
}

/**
 * What `⏎ open` acts on. There is no focused row in the transcript, so the affordance names the
 * newest thing that can be unfolded rather than promising a navigation model that does not exist.
 */
export function newestExpandableKey(entries: readonly TranscriptEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry !== undefined && isExpandable(entry)) return entry.key
  }
  return null
}
