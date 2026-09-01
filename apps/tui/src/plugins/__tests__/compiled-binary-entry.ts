import { join } from 'node:path'

import { BeforeToolHook, EDefinitionOrigin, EStage } from '@dltech/atlas-core'

import { loadPluginDirectory } from '../directory-source'
import { installPluginApi } from '../install-api'

installPluginApi()

const directory = process.argv[2] ?? ''

const read = await loadPluginDirectory({ directory, origin: EDefinitionOrigin.User })

const imported: { token: unknown; stage: unknown } = await import(join(directory, 'identity.ts'))

console.log(
  JSON.stringify({
    loaded: read.plugins.map((entry) => entry.plugin.id),
    refused: read.refusals.map((entry) => `${entry.refusal}: ${entry.detail}`),
    identicalClass: imported.token === BeforeToolHook,
    identicalEnum: imported.stage === EStage,
  }),
)
