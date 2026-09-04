import { posix } from 'node:path'

import { z } from 'zod'

import { EMountMode, type Mount } from './mounts'
import { EConfigRefusal, type ConfigRefusal } from './refusals'

export const MAX_MOUNT_PATH_LENGTH = 512

export const RESERVED_CONTAINER_PATHS: readonly string[] = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/boot',
  '/proc',
  '/sys',
  '/dev',
  '/run',
]

export type ContainerJsonFields = {
  image?: string | undefined
  setup?: string | undefined
  start?: string | undefined
}

export type ParsedContainerJson =
  | {
      ok: true
      config: ContainerJsonFields
      mounts: readonly Mount[]
      refusals: readonly ConfigRefusal[]
    }
  | { ok: false; refusal: ConfigRefusal }

export type ParsedDevcontainerJson =
  | { ok: true; image?: string | undefined; setup?: string | undefined; ignored: readonly string[] }
  | { ok: false; refusal: ConfigRefusal }

const mountSchema = z.strictObject({
  path: z.string().min(1),
  mode: z.enum(EMountMode).optional(),
})

const containerJsonSchema = z.strictObject({
  image: z.string().min(1).optional(),
  setup: z.string().min(1).optional(),
  start: z.string().min(1).optional(),
  mounts: z.array(mountSchema).optional(),
})

const devcontainerSchema = z.looseObject({
  image: z.string().min(1).optional(),
  postCreateCommand: z.unknown().optional(),
})

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const firstIssueOf = (error: z.ZodError): string => {
  const issue = error.issues[0]
  if (issue === undefined) return 'the file did not match the schema'
  const where = issue.path.join('.')
  return where === '' ? issue.message : `${where}: ${issue.message}`
}

const parseJson = (args: { text: string; file: string }): unknown | ConfigRefusal => {
  try {
    return JSON.parse(args.text)
  } catch (error) {
    return {
      refusal: EConfigRefusal.NotJson,
      file: args.file,
      detail: `the file is not valid JSON: ${messageOf(error)}`,
    }
  }
}

const isRefusal = (value: unknown | ConfigRefusal): value is ConfigRefusal =>
  typeof value === 'object' && value !== null && 'refusal' in value

const isReservedPath = (path: string): boolean => {
  if (path === '/') return true
  return RESERVED_CONTAINER_PATHS.some((reserved) => {
    return (
      path === reserved || path.startsWith(`${reserved}/`) || reserved.startsWith(`${path}/`)
    )
  })
}

type MountPathCheck = { ok: true; path: string } | { ok: false; refusal: ConfigRefusal }

const checkMountPath = (args: { path: string; file: string }): MountPathCheck => {
  const refused = (refusal: EConfigRefusal, detail: string): MountPathCheck => ({
    ok: false,
    refusal: { refusal, file: args.file, detail },
  })

  const path = posix.normalize(args.path).replace(/\/+$/, '') || '/'

  if (!posix.isAbsolute(args.path)) {
    return refused(
      EConfigRefusal.MountRelative,
      `mount "${args.path}" is not an absolute host path — mounts must be absolute, because they are bind-mounted at their own path inside the container`,
    )
  }
  if (args.path.split('/').includes('..')) {
    return refused(
      EConfigRefusal.MountDotDot,
      `mount "${args.path}" contains a ".." component — name the real path instead`,
    )
  }
  if (path.length > MAX_MOUNT_PATH_LENGTH) {
    return refused(
      EConfigRefusal.MountOverLong,
      `mount "${args.path}" is ${path.length} characters, over the ${MAX_MOUNT_PATH_LENGTH} limit`,
    )
  }
  if (isReservedPath(path)) {
    return refused(
      EConfigRefusal.MountReserved,
      `mount "${args.path}" targets a reserved container path — mounting over it would shadow the toolchain or the runtime`,
    )
  }

  return { ok: true, path }
}

export function parseContainerJson(args: { text: string; file: string }): ParsedContainerJson {
  const raw = parseJson(args)
  if (isRefusal(raw)) return { ok: false, refusal: raw }

  const parsed = containerJsonSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      refusal: {
        refusal: EConfigRefusal.BadShape,
        file: args.file,
        detail: firstIssueOf(parsed.error),
      },
    }
  }

  const mounts: Mount[] = []
  const refusals: ConfigRefusal[] = []
  for (const entry of parsed.data.mounts ?? []) {
    const checked = checkMountPath({ path: entry.path, file: args.file })
    if (!checked.ok) {
      refusals.push(checked.refusal)
      continue
    }
    mounts.push({ path: checked.path, mode: entry.mode ?? EMountMode.ReadOnly })
  }

  const { image, setup, start } = parsed.data
  return { ok: true, config: { image, setup, start }, mounts, refusals }
}

const UNSUPPORTED_COMMAND_SHAPE = 'postCreateCommand (only the string form is supported)'

export function parseDevcontainerJson(args: { text: string; file: string }): ParsedDevcontainerJson {
  const raw = parseJson(args)
  if (isRefusal(raw)) return { ok: false, refusal: raw }

  const parsed = devcontainerSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      refusal: {
        refusal: EConfigRefusal.BadShape,
        file: args.file,
        detail: firstIssueOf(parsed.error),
      },
    }
  }

  const supported = new Set(['image', 'postCreateCommand'])
  const ignored = Object.keys(parsed.data).filter((key) => !supported.has(key))

  const command = parsed.data.postCreateCommand
  if (command !== undefined && typeof command !== 'string') ignored.push(UNSUPPORTED_COMMAND_SHAPE)

  return {
    ok: true,
    image: parsed.data.image,
    setup: typeof command === 'string' && command.trim() !== '' ? command : undefined,
    ignored,
  }
}
