import { stat } from 'node:fs/promises'

import {
  EContentAccess,
  EPathForm,
  EPathPresence,
  EToolEffect,
  SchemaTool,
  type DeclaredPathField,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'
import { z } from 'zod'

import {  portToken } from '../../container/injection'
import { writeFileAtomically } from '../../files/atomic-write'
import { FileWriteGuardPort, SerializedWrites } from '../../files/write-guard'
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

export class WriteTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'write'
  readonly description = description
  readonly effect = EToolEffect.Write
  readonly inputSchema = inputSchema
  override readonly pathFields: readonly DeclaredPathField[] = [
    { field: 'path', presence: EPathPresence.Required, form: EPathForm.Absolute, content: EContentAccess.Overwrites },
  ]

  constructor(
    
    private readonly guard: FileWriteGuardPort = new SerializedWrites(),
  ) {
    super()
  }

  protected override async run({
    input,
    threadId,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const { path, content } = input

    const guarded = await this.guard.underLock({
      threadId,
      path,
      write: async (): Promise<ToolOutcome> => {
        const stats = await stat(path).catch(() => null)
        if (stats !== null && !stats.isFile()) {
          return { ok: false, reason: `${path} already exists and is not a regular file.` }
        }

        const bytes = await writeFileAtomically({ path, content, mode: stats?.mode })
        const created = stats === null

        return {
          ok: true,
          output: { path, created, bytes },
          modelText: created
            ? `File created successfully at: ${path}`
            : `The file ${path} has been updated successfully.`,
        }
      },
    })

    return guarded.ok ? guarded.value : { ok: false, reason: guarded.reason }
  }
}

