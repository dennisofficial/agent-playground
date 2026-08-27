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

export function bindSettings(args: {
  container: DependencyContainer
  env: Record<string, string | undefined>
  cwd: string
}): SettingsService {
  const userFile = userSettingsFile()
  const projectFile = projectSettingsFile(args.cwd)

  args.container.register(UserSettingsStoreToken, {
    useValue: new FileSettingsStore({
      file: userFile,
      label: collapseHome({ cwd: userFile, home: homedir() }),
    }),
  })

  args.container.register(ProjectSettingsStoreToken, {
    useValue: new FileSettingsStore({
      file: projectFile,
      label: `${PROJECT_PREFIX}/${relative(args.cwd, projectFile)}`,
    }),
  })

  return createSettingsService({
    definitions: ATLAS_SETTINGS,
    user: args.container.resolve(UserSettingsStoreToken),
    project: args.container.resolve(ProjectSettingsStoreToken),
    environment: environmentLayer({ definitions: ATLAS_SETTINGS, env: args.env }),
  })
}
