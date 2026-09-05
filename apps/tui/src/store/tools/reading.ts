/**
 * What can be read off a settled call, before anything decides what to call it.
 *
 * Every accessor here is defensive about shape: a tool's output is whatever that tool chose to
 * return, and a transcript written by an older build has to keep rendering.
 */

import { parseUnifiedDiff, type DiffFile } from '@dltech/atlas-core'

import { ECallState, type ToolCall } from '../tool-runs'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const outputOf = (call: ToolCall): Record<string, unknown> =>
  isRecord(call.output) ? call.output : {}

export const inputOf = (call: ToolCall): Record<string, unknown> =>
  isRecord(call.input) ? call.input : {}

export const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

export const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

export const records = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : []

export const relativise = (path: string, cwd: string): string =>
  cwd.length > 0 && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path

export const count = (value: number): string => value.toLocaleString('en-US')

export const plural = (many: number, one: string, rest = `${one}s`): string =>
  `${count(many)} ${many === 1 ? one : rest}`

const COMMAND_MAX = 72

export const clip = (text: string, max: number): string =>
  [...text].length <= max ? text : `${[...text].slice(0, max - 1).join('')}…`

/**
 * What the MODEL said a command does.
 *
 * The bash tool asks for it on every call and it is the one field in the payload written to be read —
 * `Rename wide to roomy and typecheck` beats `cd … && python3 - <<'PY'` in every row it appears in.
 */
export function commandLabel(call: ToolCall): string {
  const input = inputOf(call)
  const description = str(input.description)
  if (description !== undefined) return description

  const command = str(input.command)
  if (command === undefined) return call.name

  const first = command.split('\n')[0] ?? ''
  return clip(command.includes('\n') ? `${first} …` : first, COMMAND_MAX)
}

export function targetOf(args: { call: ToolCall; cwd: string }): string | undefined {
  const input = inputOf(args.call)
  const path = str(input.path) ?? str(input.file_path) ?? str(input.filePath)
  if (path !== undefined) return relativise(path, args.cwd)

  switch (args.call.name) {
    case 'bash':
      return commandLabel(args.call)
    case 'grep':
    case 'glob':
      return str(input.pattern)
    case 'shell_output':
    case 'shell_kill':
      return str(input.shellId) ?? str(input.shell_id)
    case 'skill':
      return str(input.name)
    default:
      return str(input.query) ?? str(input.pattern) ?? str(input.command)
  }
}

/**
 * The body a `write` sends, which rides on the CALL rather than the result — so it can be read while
 * the call is still arriving, before the tool has run at all.
 */
export const writtenContentOf = (call: ToolCall): string | undefined =>
  str(inputOf(call).content) ?? str(inputOf(call).text)

/**
 * The body a file-changing call is dictating, drawn while the arguments are still arriving. A
 * `write` sends the whole file; an `edit` sends only the replacement text.
 */
export function dictatedContentOf(call: ToolCall): string | undefined {
  if (call.name === 'write') return writtenContentOf(call)
  if (call.name === 'edit') return str(inputOf(call).newString)
  return undefined
}

export function diffOf(call: ToolCall): DiffFile | null {
  const patch = str(outputOf(call).diff)
  if (patch === undefined) return null
  const [file] = parseUnifiedDiff(patch)
  return file ?? null
}

export function diffStatOf(call: ToolCall): { added: number; removed: number } | null {
  const file = diffOf(call)
  return file === null ? null : { added: file.added, removed: file.removed }
}

const MAX_DETAIL = 200

/**
 * Everything a command printed, in the order the model was given it.
 *
 * The bash tool keeps the two streams apart in its output, so reading only `stdout` hides exactly
 * the lines that say why a command failed.
 */
function printed(output: Record<string, unknown>): string | undefined {
  const out = str(output.stdout)
  const err = str(output.stderr)
  if (out === undefined) return err
  return err === undefined ? out : `${out}\n${err}`
}

/** Why a call never ran, or why it came back an error — the sentence the model was handed. */
export const reasonOf = (call: ToolCall): string => call.note ?? ''

/** What an opened call has to show, whatever shape it came back in. */
export function detailOf(call: ToolCall): readonly string[] {
  if (call.state === ECallState.Denied) return call.note === null ? [] : [call.note]

  const output = outputOf(call)
  const matches = strings(output.matches)
  const paths = strings(output.paths)
  const body =
    printed(output) ??
    str(output.text) ??
    (matches.length > 0 ? matches.join('\n') : undefined) ??
    (paths.length > 0 ? paths.join('\n') : undefined) ??
    call.modelText

  if (body.length === 0) return []
  return body.split('\n').slice(0, MAX_DETAIL)
}

/** The command in full, for a bash call whose row shows the model's description instead. */
export function commandLines(call: ToolCall): readonly string[] {
  const command = str(inputOf(call).command)
  if (command === undefined) return []
  if (command === commandLabel(call)) return []
  return command.split('\n')
}

export const lineCount = (text: string): number => (text.length === 0 ? 0 : text.split('\n').length)

/**
 * The sentence form, when there is something to put in it.
 *
 * `Read read` is what a fabricated one looks like: a call with no target has nothing for the verb to
 * take, and prefixing the tool's own name with a verb reads as a stutter. Better to fall back to the
 * bare label than to invent a sentence about nothing.
 */
export const standing = (args: { verb: string; target: string | undefined }): { alone?: string } =>
  args.target === undefined ? {} : { alone: `${args.verb} ${args.target}` }

/**
 * A page is named by its host and path, never by its scheme or its query. The scheme is the same on
 * every row and the query is usually longer than everything around it.
 */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
    return `${parsed.hostname.replace(/^www\./, '')}${path}`
  } catch {
    return url
  }
}
