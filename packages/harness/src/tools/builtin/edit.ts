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
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
})

const description = [
  'Replace an exact string in a text file.',
  'A relative path resolves against the project directory.',
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
  mode: number | undefined
  files: FileSystemPort
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

  await writeFileAtomically({ path: args.path, content: args.newString, mode: args.mode, files: args.files })

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
  mode: number
  files: FileSystemPort
}): Promise<ToolOutcome> {
  const raw = await Bun.file(args.path).text()
  const replaced = replaceInContent({
    content: raw,
    oldString: args.oldString,
    newString: args.newString,
    replaceAll: args.replaceAll,
  })
  if (!replaced.ok) return { ok: false, reason: replaced.reason }

  await writeFileAtomically({ path: args.path, content: replaced.content, mode: args.mode, files: args.files })

  return {
    ok: true,
    output: {
      path: args.path,
      diff: renderUnifiedDiff({
        path: args.path,
        oldContent: toLf(raw),
        newContent: toLf(replaced.content),
      }),
    },
    modelText: updated(args.path),
  }
}

export class EditTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'edit'
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
    const { oldString, newString, replaceAll } = input

    const guarded = await this.guard.underLock({
      threadId,
      path,
      write: async (): Promise<ToolOutcome> => {
        const stats = await this.files.stat({ path }).catch(() => null)
        if (stats !== null && !stats.isFile()) {
          return { ok: false, reason: `${path} is not a regular file.` }
        }

        if (oldString === '') {
          const existing = stats === null ? null : await Bun.file(path).text()
          return await createFile({ path, newString, existing, mode: stats?.mode, files: this.files })
        }

        if (stats === null) return { ok: false, reason: `File does not exist: ${path}` }

        return await replaceInFile({
          path,
          oldString,
          newString,
          replaceAll: replaceAll ?? false,
          mode: stats.mode,
          files: this.files,
        })
      },
    })

    return guarded.ok ? guarded.value : { ok: false, reason: guarded.reason }
  }
}

