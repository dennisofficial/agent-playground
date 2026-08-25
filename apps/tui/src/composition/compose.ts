import { defaultRules, type CredentialPort, type EventLogPort, type IdPort } from '@dltech/atlas-core'
import {
  buildHarness,
  createAnthropicOauthModel,
  createDeltaChannel,
  createPublishingTurnRunner,
  createSecurityKeychainReader,
  KeychainCredentialPort,
  SystemClock,
  type BranchStorePort,
  type DeltaChannel,
  type TurnRunner,
} from '@dltech/atlas-harness'

import type { AtlasConfig } from './config'

export type AtlasApp = {
  config: AtlasConfig
  credentials: CredentialPort
  channel: DeltaChannel
  runner: TurnRunner
  log: EventLogPort
  branches: BranchStorePort
  ids: IdPort
  close: () => Promise<void>
}

export async function composeAtlas(args: { config: AtlasConfig }): Promise<AtlasApp> {
  const { config } = args

  const clock = new SystemClock()
  const credentials = new KeychainCredentialPort({
    reader: createSecurityKeychainReader(),
    clock,
    ...(config.keychainService === undefined ? {} : { service: config.keychainService }),
  })

  const harness = await buildHarness({
    databaseUrl: config.databaseUrl,
    clock,
    model: createAnthropicOauthModel({
      credentials,
      modelId: config.modelId,
      providerOptions: {
        anthropic: { thinking: { type: 'enabled', budgetTokens: config.thinkingBudgetTokens } },
      },
    }),
  })

  const channel = createDeltaChannel()

  return {
    config,
    credentials,
    channel,
    log: harness.log,
    branches: harness.branches,
    ids: harness.ids,
    close: harness.close,
    runner: createPublishingTurnRunner({
      channel,
      deps: {
        log: harness.log,
        model: harness.model,
        ids: harness.ids,
        rules: defaultRules(),
      },
    }),
  }
}
