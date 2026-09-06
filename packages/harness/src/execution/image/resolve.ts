import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DEFAULT_SANDBOX_IMAGE } from '../docker/sandbox'
import { EBuildContext } from './build'
import { type Mount } from './mounts'
import { parseContainerJson, parseDevcontainerJson } from './parse'
import { EConfigRefusal, type ConfigRefusal } from './refusals'

export enum EConfigSource {
  ContainerJson = 'container.json',
  DevcontainerJson = 'devcontainer.json',
  Dockerfile = 'Dockerfile',
  BuiltIn = 'built-in default',
}

export enum EImageKind {
  Image = 'image',
  Dockerfile = 'dockerfile',
}

export type ImageRef =
  | { kind: EImageKind.Image; reference: string }
  | { kind: EImageKind.Dockerfile; path: string; context: EBuildContext }

export type ContainerResolution = {
  image: ImageRef
  setup?: string | undefined
  start?: string | undefined
  env: Record<string, string>
  mounts: readonly Mount[]
  source: EConfigSource
  notes: readonly string[]
  refusals: readonly ConfigRefusal[]
}

export type TextFileReader = (path: string) => Promise<string | undefined>

export const readTextFile: TextFileReader = async (path) => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined
    }
    throw error
  }
}

const dockerfileNote = (path: string): string =>
  `${path}: building this Dockerfile is the escape hatch, taken because nothing names an image — naming one in .atlas/container.json starts faster and cannot break on a build, so keep the Dockerfile for when no image is enough`

const ignoredNote = (args: { file: string; ignored: readonly string[] }): string =>
  `${args.file}: ignored ${args.ignored.join(', ')} — only image and postCreateCommand are read from a devcontainer.json`

export async function resolveContainerConfig(args: {
  projectDirectory: string
  atlasHome?: string | undefined
  readText?: TextFileReader
}): Promise<ContainerResolution> {
  const read = args.readText ?? readTextFile
  const refusals: ConfigRefusal[] = []
  const notes: string[] = []

  const containerFile = join(args.projectDirectory, '.atlas', 'container.json')
  const containerText = await read(containerFile)
  if (containerText !== undefined) {
    const parsed = parseContainerJson({ text: containerText, file: containerFile })
    if (parsed.ok) {
      refusals.push(...parsed.refusals)
      return {
        image: {
          kind: EImageKind.Image,
          reference: parsed.config.image ?? DEFAULT_SANDBOX_IMAGE,
        },
        setup: parsed.config.setup,
        start: parsed.config.start,
        env: parsed.config.env ?? {},
        mounts: parsed.mounts,
        source: EConfigSource.ContainerJson,
        notes,
        refusals,
      }
    }
    refusals.push(parsed.refusal)
  }

  const devcontainerFile = join(args.projectDirectory, '.devcontainer', 'devcontainer.json')
  const devcontainerText = await read(devcontainerFile)
  if (devcontainerText !== undefined) {
    const parsed = parseDevcontainerJson({ text: devcontainerText, file: devcontainerFile })
    if (!parsed.ok) {
      refusals.push(parsed.refusal)
    } else if (parsed.image !== undefined || parsed.setup !== undefined) {
      if (parsed.ignored.length > 0) {
        notes.push(ignoredNote({ file: devcontainerFile, ignored: parsed.ignored }))
      }
      return {
        image: {
          kind: EImageKind.Image,
          reference: parsed.image ?? DEFAULT_SANDBOX_IMAGE,
        },
        setup: parsed.setup,
        start: undefined,
        env: {},
        mounts: [],
        source: EConfigSource.DevcontainerJson,
        notes,
        refusals,
      }
    } else {
      notes.push(
        `${devcontainerFile}: carried neither image nor postCreateCommand, so it configures nothing`,
      )
    }
  }

  const dockerfile = join(args.projectDirectory, '.atlas', 'Dockerfile')
  if ((await read(dockerfile)) !== undefined) {
    notes.push(dockerfileNote(dockerfile))
    return {
      image: { kind: EImageKind.Dockerfile, path: dockerfile, context: EBuildContext.Directory },
      env: {},
      mounts: [],
      source: EConfigSource.Dockerfile,
      notes,
      refusals,
    }
  }

  if (args.atlasHome !== undefined) {
    const userDockerfile = join(args.atlasHome, 'Dockerfile')
    if ((await read(userDockerfile)) !== undefined) {
      notes.push(dockerfileNote(userDockerfile))
      return {
        image: {
          kind: EImageKind.Dockerfile,
          path: userDockerfile,
          context: EBuildContext.DockerfileOnly,
        },
        env: {},
        mounts: [],
        source: EConfigSource.Dockerfile,
        notes,
        refusals,
      }
    }
  }

  return {
    image: { kind: EImageKind.Image, reference: DEFAULT_SANDBOX_IMAGE },
    env: {},
    mounts: [],
    source: EConfigSource.BuiltIn,
    notes,
    refusals,
  }
}
