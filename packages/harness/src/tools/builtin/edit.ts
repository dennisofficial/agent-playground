import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  EPathForm,
  EPathPresence,
  EToolEffect,
  type DeclaredPathField,
  type ToolDefinition,
  type ToolInvocation,
  type ToolOutcome,
} from '@dltech/atlas-core'
import { z } from 'zod'

import { injectable } from '../../container/injection'
import {
  absolutePathSchema,
  detectLineEnding,
  endingOfRegion,
  lineEndingAgnosticPattern,
  toLf,
  withLineEnding,
} from './file-text'
import { renderUnifiedDiff } from './unified-diff'

const inputSchema = z.strictObject({
  path: absolutePathSchema,
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
})

const description = [
  'Replace an exact string in a text file.',
  'The path must be absolute.',
  'oldString must match the file exactly, including indentation, and must be unique unless replaceAll is true.',
  'An empty oldString creates the file with newString as its whole content.',
  'Lines the edit does not touch keep their exact bytes, line endings included.',
].join(' ')

const updated = (path: string): string => `The file ${path} has been updated successfully.`

const created = (path: string): string => `File created successfully at: ${path}`

async function createFile(args: {
  path: string
  newString: string
  existing: string | null
}): Promise<ToolOutcome> {
  if (args.newString === '') {
    return {
      ok: false,
      reason:
        'An empty oldString with an empty newString names nothing to replace and nothing to write. Use the write tool with an empty content to create or empty a file.',
    }
  }

  if (args.existing !== null && args.existing.trim() !== '') {
    return { ok: false, reason: 'Cannot create new file - file already exists.' }
  }

  await mkdir(dirname(args.path), { recursive: true })
  await Bun.write(args.path, args.newString)

  return {
    ok: true,
    output: {
      path: args.path,
      diff: renderUnifiedDiff({
        path: args.path,
        oldContent: args.existing,
        newContent: args.newString,
      }),
    },
    modelText: args.existing === null ? created(args.path) : updated(args.path),
  }
}

async function replaceInFile(args: {
  path: string
  oldString: string
  newString: string
  replaceAll: boolean
}): Promise<ToolOutcome> {
  const raw = await Bun.file(args.path).text()
  const pattern = lineEndingAgnosticPattern(args.oldString)

  const matches = [...raw.matchAll(new RegExp(pattern, 'g'))].length
  if (matches === 0) {
    return { ok: false, reason: `String to replace not found in file.\nString: ${args.oldString}` }
  }
  if (matches > 1 && !args.replaceAll) {
    return {
      ok: false,
      reason: `Found ${matches} matches of the string to replace, but replaceAll is false. To replace all occurrences, set replaceAll to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${args.oldString}`,
    }
  }

  const fallback = detectLineEnding(raw)
  const replacement = toLf(args.newString)
  const rewritten = raw.replace(new RegExp(pattern, args.replaceAll ? 'g' : ''), (region) =>
    withLineEnding({ content: replacement, ending: endingOfRegion({ region, fallback }) }),
  )

  if (rewritten === raw) {
    return { ok: false, reason: 'oldString and newString are identical; the file would not change.' }
  }

  await Bun.write(args.path, rewritten)

  return {
    ok: true,
    output: {
      path: args.path,
      diff: renderUnifiedDiff({
        path: args.path,
        oldContent: toLf(raw),
        newContent: toLf(rewritten),
      }),
    },
    modelText: updated(args.path),
  }
}

@injectable()
export class EditTool implements ToolDefinition {
  readonly name = 'edit'
  readonly description = description
  readonly effect = EToolEffect.Write
  readonly inputSchema = inputSchema
  readonly pathFields: readonly DeclaredPathField[] = [
    { field: 'path', presence: EPathPresence.Required, form: EPathForm.Absolute },
  ]

  async invoke({ input }: ToolInvocation): Promise<ToolOutcome> {
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success) return { ok: false, reason: `edit was called with invalid input: ${z.prettifyError(parsed.error)}` }

    const { path, oldString, newString, replaceAll } = parsed.data
    const stats = await stat(path).catch(() => null)
    if (stats !== null && !stats.isFile()) return { ok: false, reason: `${path} is not a regular file.` }

    if (oldString === '') {
      const existing = stats === null ? null : await Bun.file(path).text()
      return await createFile({ path, newString, existing })
    }

    if (stats === null) return { ok: false, reason: `File does not exist: ${path}` }

    return await replaceInFile({ path, oldString, newString, replaceAll: replaceAll ?? false })
  }
}

export const createEditTool = (): ToolDefinition => new EditTool()
