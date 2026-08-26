import { defaultRules, type CredentialPort, type EventLogPort, type IdPort } from '@dltech/atlas-core'
import {
  buildHarness,
  createDeltaChannel,
  createPublishingTurnRunner,
  createSecurityKeychainReader,
  KeychainCredentialPort,
  SystemClock,
  type BranchStorePort,
  type DeltaChannel,
  type SettingsService,
  type TurnRunner,
} from '@dltech/atlas-harness'

import type { AtlasConfig } from './config'
import { launchSelection, rememberSelection } from './model-preference'
import { selectableModel, type ModelChoice } from './model-selection'
import { bindSettings } from './settings-binding'
import { bindTools } from './tool-binding'

export type AtlasApp = {
  config: AtlasConfig
  credentials: CredentialPort
  channel: DeltaChannel
  runner: TurnRunner
  log: EventLogPort
  branches: BranchStorePort
  ids: IdPort
  model: ModelChoice
  settings: SettingsService
  close: () => Promise<void>
}

export async function composeAtlas(args: {
  config: AtlasConfig
  env: Record<string, string | undefined>
}): Promise<AtlasApp> {
  const { config } = args

  const clock = new SystemClock()
  const credentials = new KeychainCredentialPort({
    reader: createSecurityKeychainReader(),
    clock,
    ...(config.keychainService === undefined ? {} : { service: config.keychainService }),
  })

  const settings = bindSettings({ env: args.env, cwd: config.cwd })

  const model = selectableModel({
    credentials,
    initial: launchSelection({
      requested: { modelId: config.modelId, thinkingBudgetTokens: config.thinkingBudgetTokens },
      remembered: settings.snapshot().document,
    }),
    remember: (selection) => rememberSelection({ settings, selection }),
  })

  const harness = await buildHarness({ databaseUrl: config.databaseUrl, clock, model: model.model })

  const channel = createDeltaChannel()
  const tools = bindTools({ root: config.cwd })

  return {
    config,
    settings,
    credentials,
    channel,
    log: harness.log,
    branches: harness.branches,
    ids: harness.ids,
    model,
    close: harness.close,
    runner: createPublishingTurnRunner({
      channel,
      deps: {
        log: harness.log,
        model: harness.model,
        ids: harness.ids,
        rules: defaultRules({ root: config.cwd, tools: tools.declarations }),
        tools: tools.declarations,
        dispatch: tools.dispatch,
      },
    }),
  }
}
