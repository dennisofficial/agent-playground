import { stat } from 'node:fs/promises'

import { type ToolOutcome, type ToolRun } from '@dltech/atlas-core'
import { z } from 'zod'

import { writeFileAtomically } from '../../files/atomic-write'
import { compatMcpFile, projectMcpFile, userMcpFile } from '../../settings/paths'
import {
  MCP_SERVERS_FIELD,
  mcpConfigFileSchema,
  mcpServersOf,
  mcpSpecSchema,
} from './specs'

export enum EMcpEditLayer {
  User = 'user',
  Project = 'project',
  ProjectCompat = 'project-compat',
}

export enum EMcpEditAction {
  Upsert = 'upsert',
  Disable = 'disable',
  Enable = 'enable',
  Remove = 'remove',
}

export const inputSchema = z.strictObject({
  layer: z.enum(EMcpEditLayer),
  name: mcpSpecSchema.shape.name,
  transport: mcpSpecSchema.shape.transport,
  action: z.enum(EMcpEditAction),
  trusted: mcpSpecSchema.shape.trusted,
})

export type McpEditInput = z.infer<typeof inputSchema>

const fileOf = (args: { layer: EMcpEditLayer; projectDirectory: string }): string => {
  if (args.layer === EMcpEditLayer.User) return userMcpFile()
  if (args.layer === EMcpEditLayer.ProjectCompat) return compatMcpFile(args.projectDirectory)
  return projectMcpFile(args.projectDirectory)
}

const formatIssue = (issue: { path: readonly PropertyKey[]; message: string }): string => {
  const field = issue.path.map(String).join('.')
  return field === '' ? issue.message : `${field}: ${issue.message}`
}

const detailsOf = (issues: readonly { path: readonly PropertyKey[]; message: string }[]): string =>
  issues.map(formatIssue).join('; ')

type ReadTable =
  | { ok: true; wrapped: boolean; servers: Record<string, unknown> }
  | { ok: false; reason: string }

async function readTable(args: { path: string }): Promise<ReadTable> {
  const stats = await stat(args.path).catch(() => null)
  if (stats === null) return { ok: true, wrapped: false, servers: {} }
  if (!stats.isFile()) return { ok: false, reason: `${args.path} is not a regular file.` }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(await Bun.file(args.path).text())
  } catch (error) {
    return { ok: false, reason: `${args.path} is not json: ${(error as Error).message}` }
  }

  const file = mcpConfigFileSchema.safeParse(parsedJson)
  if (!file.success) {
    return {
      ok: false,
      reason: `${args.path} is not shaped like an mcp file: ${detailsOf(file.error.issues)}`,
    }
  }

  const data = file.data as Record<string, unknown>
  const wrapped =
    Object.keys(data).length === 1 && data[MCP_SERVERS_FIELD] !== undefined

  return { ok: true, wrapped, servers: { ...mcpServersOf(file.data) } }
}

type Written = { ok: true; servers: Record<string, unknown> } | { ok: false; reason: string }

const entryOf = (input: McpEditInput): Record<string, unknown> => ({
  ...(input.transport === undefined ? {} : { transport: input.transport }),
  ...(input.action === EMcpEditAction.Disable ? { disabled: true } : {}),
  ...(input.trusted === undefined ? {} : { trusted: input.trusted }),
})

const upsert = (args: { input: McpEditInput; read: ReadTable & { ok: true } }): Written => {
  const servers = { ...args.read.servers }
  for (const [name, fields] of Object.entries(servers)) {
    const entry = typeof fields === 'object' && fields !== null ? fields : {}
    const parsed = mcpSpecSchema.safeParse({ ...entry, name })
    if (!parsed.success) {
      return {
        ok: false,
        reason: `the existing server ${JSON.stringify(name)} is broken (${detailsOf(parsed.error.issues)}), so nothing was written; fix it or remove it first`,
      }
    }
  }

  const entry = entryOf(args.input)
  const checked = mcpSpecSchema.safeParse({ ...entry, name: args.input.name })
  if (!checked.success) {
    return {
      ok: false,
      reason: `server ${JSON.stringify(args.input.name)} is not writable: ${detailsOf(checked.error.issues)}`,
    }
  }

  servers[args.input.name] = entry
  return { ok: true, servers }
}

const remove = (args: { input: McpEditInput; read: ReadTable & { ok: true } }): Written => {
  const servers = { ...args.read.servers }
  delete servers[args.input.name]
  return { ok: true, servers }
}

const verbOf = (action: EMcpEditAction): string =>
  action === EMcpEditAction.Upsert
    ? 'installed'
    : action === EMcpEditAction.Disable
      ? 'disabled'
      : action === EMcpEditAction.Enable
        ? 'enabled'
        : 'removed'

export async function run(args: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
  const { input } = args
  const path = fileOf({
    layer: input.layer,
    projectDirectory: args.projectDirectory,
  })

  const read = await readTable({ path })
  if (!read.ok) return { ok: false, reason: read.reason }

  const applied =
    input.action === EMcpEditAction.Remove
      ? remove({ input, read })
      : upsert({ input, read })
  if (!applied.ok) return { ok: false, reason: applied.reason }

  const file = read.wrapped ? { [MCP_SERVERS_FIELD]: applied.servers } : applied.servers

  const stats = await stat(path).catch(() => null)
  await writeFileAtomically({
    path,
    content: `${JSON.stringify(file, null, 2)}\n`,
    mode: stats?.mode,
  })

  return {
    ok: true,
    output: { path, name: input.name, action: input.action },
    modelText: `Server ${JSON.stringify(input.name)} ${verbOf(input.action)} in ${path}.`,
  }
}
