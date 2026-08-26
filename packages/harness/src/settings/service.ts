import {
  ESettingsLayer,
  resolveSettings,
  withoutSetting,
  withSetting,
  type SettingDefinition,
  type SettingsDocument,
  type SettingsLayerInput,
  type SettingsResolution,
  type SettingsStorePort,
  type SettingValue,
} from '@dltech/atlas-core'

export type SettingsSnapshot = {
  resolution: SettingsResolution
  document: SettingsDocument
  writesTo: string
  problems: readonly string[]
}

export type SettingsWrite = { ok: true } | { ok: false; message: string }

export type SettingsService = {
  definitions: readonly SettingDefinition[]
  snapshot: () => SettingsSnapshot
  version: () => number
  subscribe: (listener: () => void) => () => void
  set: (args: { id: string; value: SettingValue }) => SettingsWrite
  clear: (args: { id: string }) => SettingsWrite
  reload: () => void
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'could not be written'

export function createSettingsService(args: {
  definitions: readonly SettingDefinition[]
  user: SettingsStorePort
  project?: SettingsStorePort
  environment?: SettingsLayerInput
}): SettingsService {
  const listeners = new Set<() => void>()
  let version = 0
  let snapshot = build()

  function readLayer(store: SettingsStorePort, layer: ESettingsLayer) {
    const read = store.read()
    return {
      input: { layer, origin: store.origin(), values: read.document.values },
      document: read.document,
      ...(read.problem === undefined ? {} : { problem: read.problem }),
    }
  }

  function build(): SettingsSnapshot {
    const user = readLayer(args.user, ESettingsLayer.User)
    const project =
      args.project === undefined ? undefined : readLayer(args.project, ESettingsLayer.Project)

    const layers: SettingsLayerInput[] = [user.input]
    if (project !== undefined) layers.push(project.input)
    if (args.environment !== undefined) layers.push(args.environment)

    const problems: string[] = []
    if (user.problem !== undefined) problems.push(user.problem)
    if (project?.problem !== undefined) problems.push(project.problem)

    return {
      resolution: resolveSettings({ definitions: args.definitions, layers }),
      document: user.document,
      writesTo: args.user.origin(),
      problems,
    }
  }

  function republish(): void {
    snapshot = build()
    version += 1
    for (const listener of listeners) listener()
  }

  function persist(next: SettingsDocument): SettingsWrite {
    try {
      args.user.write(next)
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }

    republish()
    return { ok: true }
  }

  return {
    definitions: args.definitions,
    snapshot: () => snapshot,
    version: () => version,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: ({ id, value }) =>
      persist(withSetting({ document: snapshot.document, id, value })),
    clear: ({ id }) => persist(withoutSetting({ document: snapshot.document, id })),
    reload: republish,
  }
}
