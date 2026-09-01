import { join } from 'node:path'

import { atlasDirectory } from '../store/paths'

export const ATLAS_SECRETS_NAME = 'secrets.json'

export function atlasSecretsFile(): string {
  return join(atlasDirectory(), ATLAS_SECRETS_NAME)
}
