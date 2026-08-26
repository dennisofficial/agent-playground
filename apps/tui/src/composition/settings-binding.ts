import { homedir } from 'node:os'
import { relative } from 'node:path'

import { ATLAS_SETTINGS } from '@dltech/atlas-core'
import {
  createSettingsService,
  environmentLayer,
  FileSettingsStore,
  projectSettingsFile,
  userSettingsFile,
  type SettingsService,
} from '@dltech/atlas-harness'

import { collapseHome } from '../ui/paths'

const PROJECT_PREFIX = '.'

export function bindSettings(args: {
  env: Record<string, string | undefined>
  cwd: string
}): SettingsService {
  const userFile = userSettingsFile()
  const projectFile = projectSettingsFile(args.cwd)

  return createSettingsService({
    definitions: ATLAS_SETTINGS,
    user: new FileSettingsStore({
      file: userFile,
      label: collapseHome({ cwd: userFile, home: homedir() }),
    }),
    project: new FileSettingsStore({
      file: projectFile,
      label: `${PROJECT_PREFIX}/${relative(args.cwd, projectFile)}`,
    }),
    environment: environmentLayer({ definitions: ATLAS_SETTINGS, env: args.env }),
  })
}
