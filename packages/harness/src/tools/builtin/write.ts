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
import { absolutePathSchema } from './file-text'

const inputSchema = z.strictObject({
  path: absolutePathSchema,
  content: z.string(),
})

const description = [
  'Write a text file, replacing it entirely if it already exists.',
  'The path must be absolute; missing parent directories are created.',
  'Content is written byte for byte, so send the line endings you want the file to have.',
  'Prefer the edit tool for changing part of an existing file.',
].join(' ')

@injectable()
export class WriteTool implements ToolDefinition {
  readonly name = 'write'
  readonly description = description
  readonly effect = EToolEffect.Write
  readonly inputSchema = inputSchema
  readonly pathFields: readonly DeclaredPathField[] = [
    { field: 'path', presence: EPathPresence.Required, form: EPathForm.Absolute },
  ]

  async invoke({ input }: ToolInvocation): Promise<ToolOutcome> {
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success) return { ok: false, reason: `write was called with invalid input: ${z.prettifyError(parsed.error)}` }

    const { path, content } = parsed.data
    const stats = await stat(path).catch(() => null)
    if (stats !== null && !stats.isFile()) {
      return { ok: false, reason: `${path} already exists and is not a regular file.` }
    }

    await mkdir(dirname(path), { recursive: true })
    const bytes = await Bun.write(path, content)
    const created = stats === null

    return {
      ok: true,
      output: { path, created, bytes },
      modelText: created
        ? `File created successfully at: ${path}`
        : `The file ${path} has been updated successfully.`,
    }
  }
}

export const createWriteTool = (): ToolDefinition => new WriteTool()
