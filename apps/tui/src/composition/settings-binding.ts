import { homedir } from 'node:os'
import { relative } from 'node:path'

import { ATLAS_SETTINGS } from '@dltech/atlas-core'
import {
  createSettingsService,
  environmentLayer,
  FileSettingsStore,
  ProjectSettingsStoreToken,
  projectSettingsFile,
  UserSettingsStoreToken,
  userSettingsFile,
  type DependencyContainer,
  type SettingsService,
} from '@dltech/atlas-harness'

import { collapseHome } from '../ui/paths'

const PROJECT_PREFIX = '.'

export type SettingsBinding = {
  service: SettingsService
  bindTo: (container: DependencyContainer) => void
}

/**
 * Every layer is read from disk synchronously, which is what lets the appearance the operator chose
 * be in force before the renderer draws its first frame rather than an effect away from it.
 */
export function loadSettings(args: {
  env: Record<string, string | undefined>
  cwd: string
}): SettingsBinding {
  const userFile = userSettingsFile()
  const projectFile = projectSettingsFile(args.cwd)

  const user = new FileSettingsStore({
    file: userFile,
    label: collapseHome({ cwd: userFile, home: homedir() }),
  })

  const project = new FileSettingsStore({
    file: projectFile,
    label: `${PROJECT_PREFIX}/${relative(args.cwd, projectFile)}`,
  })

  const service = createSettingsService({
    definitions: ATLAS_SETTINGS,
    user,
    project,
    environment: environmentLayer({ definitions: ATLAS_SETTINGS, env: args.env }),
  })

  return {
    service,
    bindTo: (container) => {
      container.register(UserSettingsStoreToken, { useValue: user })
      container.register(ProjectSettingsStoreToken, { useValue: project })
    },
  }
}
