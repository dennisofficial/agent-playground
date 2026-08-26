import { join } from 'node:path'

import { atlasDirectory, ATLAS_DIRECTORY_NAME } from '../store/paths'

export const ATLAS_SETTINGS_NAME = 'settings.json'

export function userSettingsFile(): string {
  return join(atlasDirectory(), ATLAS_SETTINGS_NAME)
}

export function projectSettingsFile(cwd: string): string {
  return join(cwd, ATLAS_DIRECTORY_NAME, ATLAS_SETTINGS_NAME)
}
