import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import { EToolEffect, type ToolDefinition, type ToolOutcome } from '@dltech/atlas-core'
import { z } from 'zod'

import { absolutePathSchema, detectLineEnding, toLf, withLineEnding } from './file-text'
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
  'The file keeps the line endings it already had.',
].join(' ')

const updated = (path: string): string => `The file ${path} has been updated successfully.`

const created = (path: string): string => `File created successfully at: ${path}`

async function createFile(args: {
  path: string
  newString: string
  existing: string | null
}): Promise<ToolOutcome> {
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

const replaceFirst = (args: { content: string; target: string; replacement: string }): string => {
  const at = args.content.indexOf(args.target)
  return args.content.slice(0, at) + args.replacement + args.content.slice(at + args.target.length)
}

async function replaceInFile(args: {
  path: string
  oldString: string
  newString: string
  replaceAll: boolean
}): Promise<ToolOutcome> {
  const raw = await Bun.file(args.path).text()
  const ending = detectLineEnding(raw)
  const oldContent = toLf(raw)
  const target = toLf(args.oldString)
  const replacement = toLf(args.newString)

  const matches = oldContent.split(target).length - 1
  if (matches === 0) {
    return { ok: false, reason: `String to replace not found in file.\nString: ${args.oldString}` }
  }
  if (matches > 1 && !args.replaceAll) {
    return {
      ok: false,
      reason: `Found ${matches} matches of the string to replace, but replaceAll is false. To replace all occurrences, set replaceAll to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${args.oldString}`,
    }
  }

  const newContent = args.replaceAll
    ? oldContent.split(target).join(replacement)
    : replaceFirst({ content: oldContent, target, replacement })

  if (newContent === oldContent) {
    return { ok: false, reason: 'oldString and newString are identical; the file would not change.' }
  }

  await Bun.write(args.path, withLineEnding({ content: newContent, ending }))

  return {
    ok: true,
    output: { path: args.path, diff: renderUnifiedDiff({ path: args.path, oldContent, newContent }) },
    modelText: updated(args.path),
  }
}

export function createEditTool(): ToolDefinition {
  return {
    name: 'edit',
    description,
    effect: EToolEffect.Write,
    inputSchema,
    async invoke({ input }) {
      const parsed = inputSchema.safeParse(input)
      if (!parsed.success) return { ok: false, reason: `edit received invalid input: ${parsed.error.message}` }

      const { path, oldString, newString, replaceAll } = parsed.data
      const stats = await stat(path).catch(() => null)
      if (stats !== null && !stats.isFile()) return { ok: false, reason: `${path} is not a regular file.` }

      if (oldString === '') {
        const existing = stats === null ? null : await Bun.file(path).text()
        return await createFile({ path, newString, existing })
      }

      if (stats === null) return { ok: false, reason: `File does not exist: ${path}` }

      return await replaceInFile({ path, oldString, newString, replaceAll: replaceAll ?? false })
    },
  }
}
