import { homedir } from 'node:os'
import { join } from 'node:path'

import { atlasDirectory } from '../store/paths'

export const ATLAS_VAULT_NAME = 'auth.json'
export const ATLAS_VAULT_KEY_NAME = 'key'
export const CLAUDE_DIRECTORY_NAME = '.claude'
export const CLAUDE_CREDENTIALS_NAME = '.credentials.json'

export function atlasVaultFile(): string {
  return join(atlasDirectory(), ATLAS_VAULT_NAME)
}

export function atlasVaultKeyFile(): string {
  return join(atlasDirectory(), ATLAS_VAULT_KEY_NAME)
}

export function claudeCredentialsFile(): string {
  return join(homedir(), CLAUDE_DIRECTORY_NAME, CLAUDE_CREDENTIALS_NAME)
}
