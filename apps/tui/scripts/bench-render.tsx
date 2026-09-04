import React from 'react'

import {
  ATLAS_SETTINGS,
  AccountUsagePort,
  defaultPipeline,
  EEffort,
  EMPTY_PROMPT,
  type AccountUsage,
  type ThreadId,
} from '@dltech/atlas-core'
import type { ActiveConversation } from '../src/composition/resume-hint'
import {
  createAccountUsageService,
  createDeltaChannel,
  createSettingsService,
  EMPTY_AGENT_TYPE_CATALOG,
  FileBrowser,
  MemorySecretsStore,
  MemorySettingsStore,
  PublishingTurnRunner,
  type AtlasHarness,
  type BunShellRegistry,
  type DeltaChannel,
} from '@dltech/atlas-harness'
import { testRender } from '@opentui/react/test-utils'

import { App } from '../src/composition/app'
import type { AtlasApp } from '../src/composition/compose'
import { DEFAULT_MODEL_REF, EOpenMode } from '../src/composition/config'
import { heldChoice } from '../src/composition/model-selection'
import { fakeAgentRegistry } from '../src/composition/__tests__/fake-agents'
import {
  alwaysAuthorised,
  fakeAccounts,
  fakeCatalogue,
  fakeSkillRegistry,
} from '../src/composition/__tests__/fake-app'
import { fakeServiceRegistry } from '../src/composition/__tests__/fake-services'
import { createPendingQueue } from '../src/store'
import { grammarsReady, teardown } from '../src/ui/markdown/__tests__/harness'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

export const publishingRunner = (args: {
  harness: AtlasHarness
  root: string
}): { channel: DeltaChannel; runner: PublishingTurnRunner } => {
  const channel = createDeltaChannel()
  const runner = new PublishingTurnRunner({
    channel,
    deps: {
      log: args.harness.log,
      model: args.harness.model,
      ids: args.harness.ids,
      assembly: defaultPipeline({ prompt: () => EMPTY_PROMPT, launchDirectory: args.root }),
      spend: { ledger: args.harness.ledger, clock: args.harness.clock },
      launchDirectory: args.root,
    },
  })
  return { channel, runner }
}

const benchApp = (args: {
  root: string
  harness: AtlasHarness
  shells: BunShellRegistry
  channel: DeltaChannel
  runner: PublishingTurnRunner
}): AtlasApp => {
  const skillRegistry = fakeSkillRegistry({ skills: [] })
  let active: ActiveConversation | null = null

  return {
    config: { model: undefined, open: { mode: EOpenMode.New }, cwd: args.root, executionLocation: undefined },
    workspace: { workspace: args.root, repo: null },
    markActiveThread: (next) => {
      active = next
    },
    activeThread: () => active,
    titler: async () => null,
    summarise: async () => null,
    credentials: alwaysAuthorised(),
    accounts: fakeAccounts(),
    channel: args.channel,
    runner: args.runner,
    log: args.harness.log,
    threads: args.harness.threads,
    ledger: args.harness.ledger,
    ids: args.harness.ids,
    pending: createPendingQueue(),
    shells: args.shells,
    agents: fakeAgentRegistry(),
    services: fakeServiceRegistry(),
    model: heldChoice({ ref: DEFAULT_MODEL_REF, effort: EEffort.Medium }),
    modelPinned: false,
    models: fakeCatalogue(),
    settings: createSettingsService({
      definitions: ATLAS_SETTINGS,
      user: new MemorySettingsStore({ label: 'bench-settings' }),
    }),
    secrets: new MemorySecretsStore({ label: 'bench-secrets' }),
    usage: createAccountUsageService({
      usage: new (class extends AccountUsagePort {
        async read(): Promise<AccountUsage | null> {
          return null
        }
      })(),
    }),
    files: new FileBrowser({ root: args.root }),
    openUrl: () => {},
    skills: skillRegistry.all(),
    skillRegistry,
    agentTypes: EMPTY_AGENT_TYPE_CATALOG,
    pluginProjections: [],
    pluginSurfaces: [],
    pullRequests: null,
    mcp: () => [],
    threadOpened: async () => {},
    warp: null,
    close: async () => {},
  }
}

export type BenchRender = {
  framesRendered: () => number
  close: () => Promise<void>
}

export const mountBenchRender = async (args: {
  root: string
  harness: AtlasHarness
  shells: BunShellRegistry
  channel: DeltaChannel
  runner: PublishingTurnRunner
  threadId: ThreadId
}): Promise<BenchRender> => {
  await grammarsReady()
  const setup = await testRender(
    <App
      app={benchApp(args)}
      opened={{ threadId: args.threadId, events: [], turns: [], name: 'bench-visible', started: true }}
    />,
    { width: 150, height: 40, exitOnCtrlC: false },
  )

  /**
   * testRender flips IS_REACT_ACT_ENVIRONMENT on for spec assertions; in a streaming bench every
   * channel-driven update then logs an act() warning. Nothing here is a spec, so flip it back.
   */
  globalThis.IS_REACT_ACT_ENVIRONMENT = false

  await setup.flush()
  return {
    framesRendered: () => setup.renderer.getStats().frameCount,
    close: () => teardown(setup),
  }
}
