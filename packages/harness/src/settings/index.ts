export { environmentLayer, ENVIRONMENT_ORIGIN } from './environment'
export { FileSettingsStore } from './file-store'
export { MemorySettingsStore } from './memory-store'
export {
  ATLAS_PLUGINS_DIRECTORY_NAME,
  ATLAS_SETTINGS_NAME,
  projectPluginsDirectory,
  projectSettingsFile,
  userPluginsDirectory,
  userSettingsFile,
} from './paths'
export {
  createSettingsService,
  type SettingsService,
  type SettingsSnapshot,
  type SettingsWrite,
} from './service'
