import { join } from 'node:path'

import { atlasDirectory, ATLAS_DIRECTORY_NAME } from '../store/paths'

export const ATLAS_SETTINGS_NAME = 'settings.json'

export const ATLAS_PLUGINS_DIRECTORY_NAME = 'plugins'

export const SKILLS_DIRECTORY_NAME = 'skills'

export function userSettingsFile(): string {
  return join(atlasDirectory(), ATLAS_SETTINGS_NAME)
}

export function projectSettingsFile(cwd: string): string {
  return join(cwd, ATLAS_DIRECTORY_NAME, ATLAS_SETTINGS_NAME)
}

export function userPluginsDirectory(): string {
  return join(atlasDirectory(), ATLAS_PLUGINS_DIRECTORY_NAME)
}

export function userSkillsDirectory(): string {
  return join(atlasDirectory(), SKILLS_DIRECTORY_NAME)
}

export function projectSkillsDirectory(cwd: string): string {
  return join(cwd, ATLAS_DIRECTORY_NAME, SKILLS_DIRECTORY_NAME)
}

export function projectPluginsDirectory(cwd: string): string {
  return join(cwd, ATLAS_DIRECTORY_NAME, ATLAS_PLUGINS_DIRECTORY_NAME)
}

export const ATLAS_MCP_FILE_NAME = 'mcp.json'

export const COMPAT_MCP_FILE_NAME = '.mcp.json'

export function userMcpFile(): string {
  return join(atlasDirectory(), ATLAS_MCP_FILE_NAME)
}

export function projectMcpFile(cwd: string): string {
  return join(cwd, ATLAS_DIRECTORY_NAME, ATLAS_MCP_FILE_NAME)
}

export function compatMcpFile(cwd: string): string {
  return join(cwd, COMPAT_MCP_FILE_NAME)
}
