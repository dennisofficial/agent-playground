import {
  EContentAccess,
  EPathForm,
  EPathPresence,
  EToolEffect,
  FileSystemPort,
  SchemaTool,
  type DeclaredPathField,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'
import { z } from 'zod'

import { LocalFileSystemPort } from '../../execution/local-filesystem'
import { writeFileAtomically } from '../../files/atomic-write'
import { FileWriteGuardPort, SerializedWrites } from '../../files/write-guard'
import { filePathSchema, resolveToolPath, toLf } from './file-text'
import { replaceInContent } from './replace-text'
import { renderUnifiedDiff } from './unified-diff'

const inputSchema = z.strictObject({
  path: filePathSchema,
  edits: z
    .array(
      z.strictObject({
        oldString: z.string(),
        newString: z.string(),
        replaceAll: z.boolean().optional(),
      }),
    )
    .min(1),
})

const description = [
  'Apply several edits to one file in a single call.',
  'A relative path resolves against the project directory.',
  'Each edit follows the edit tool\'s rules: oldString must match the file exactly, including indentation, and must be unique unless that edit\'s replaceAll is true.',
  'Edits apply in array order, each against the result of the ones before it, and the file is written once — if any edit fails, nothing is written.',
  'Prefer this over consecutive edit calls when changing several places in the same file. To create a file, use write.',
].join(' ')

export class MultiEditTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'multi_edit'
  readonly description = description
  readonly effect = EToolEffect.Write
  readonly inputSchema = inputSchema
  override readonly pathFields: readonly DeclaredPathField[] = [
    { field: 'path', presence: EPathPresence.Required, form: EPathForm.Absolute, content: EContentAccess.Amends },
  ]

  constructor(
    private readonly guard: FileWriteGuardPort = new SerializedWrites(),
    private readonly files: FileSystemPort = new LocalFileSystemPort(),
  ) {
    super()
  }

  protected override async run({
    input,
    threadId,
    projectDirectory,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const path = resolveToolPath({ projectDirectory, path: input.path })

    const guarded = await this.guard.underLock({
      threadId,
      path,
      write: async (): Promise<ToolOutcome> => {
        const empty = input.edits.findIndex((edit) => edit.oldString === '')
        if (empty !== -1) {
          return {
            ok: false,
            reason: `Edit ${empty + 1} of ${input.edits.length} has an empty oldString. multi_edit changes an existing file; to create one, use the write tool.`,
          }
        }

        const stats = await this.files.stat({ path }).catch(() => null)
        if (stats === null) return { ok: false, reason: `File does not exist: ${path}` }
        if (!stats.isFile()) return { ok: false, reason: `${path} is not a regular file.` }

        const raw = await Bun.file(path).text()
        let content = raw
        for (const [index, edit] of input.edits.entries()) {
          const replaced = replaceInContent({
            content,
            oldString: edit.oldString,
            newString: edit.newString,
            replaceAll: edit.replaceAll ?? false,
          })
          if (!replaced.ok) {
            return {
              ok: false,
              reason: `Edit ${index + 1} of ${input.edits.length}: ${replaced.reason}`,
            }
          }
          content = replaced.content
        }

        await writeFileAtomically({ path, content, mode: stats.mode, files: this.files })

        return {
          ok: true,
          output: {
            path,
            diff: renderUnifiedDiff({ path, oldContent: toLf(raw), newContent: toLf(content) }),
          },
          modelText: `The file ${path} has been updated successfully.`,
        }
      },
    })

    return guarded.ok ? guarded.value : { ok: false, reason: guarded.reason }
  }
}
