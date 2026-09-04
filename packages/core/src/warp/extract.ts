import type { Event } from '../events/envelope'
import { eventsOfType } from '../events/projections'
import { truncateForWarpNotification } from './sequence'

export function warpStopTexts({
  events,
}: {
  events: readonly Event[]
}): { query: string; response: string } | undefined {
  const said = eventsOfType({ events, type: 'assistant-said' }).at(-1)
  if (said === undefined) return undefined

  const response = said.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
  const query = eventsOfType({ events, type: 'user-said' }).at(-1)?.text ?? ''
  return { query, response }
}

const INPUT_PREVIEW_LIMIT = 80
const SUMMARY_PREVIEW_LIMIT = 120

// Mirrors the summary Warp's own Claude Code plugin builds, so the
// notification center renders Atlas requests the way it renders theirs:
// https://github.com/warpdotdev/claude-code-warp/blob/main/plugins/warp/scripts/on-permission-request.sh
export function summarizeWarpPermission({
  toolName,
  toolInput,
}: {
  toolName: string
  toolInput: unknown
}): string {
  const preview = previewOf(toolInput)
  if (preview === undefined) return `Wants to run ${toolName}`
  return `Wants to run ${toolName}: ${truncateForWarpNotification({ text: preview, limit: SUMMARY_PREVIEW_LIMIT })}`
}

function previewOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>

  const command = record.command
  if (typeof command === 'string' && command !== '') return command

  const filePath = record.file_path
  if (typeof filePath === 'string' && filePath !== '') return filePath

  return JSON.stringify(input).slice(0, INPUT_PREVIEW_LIMIT)
}
