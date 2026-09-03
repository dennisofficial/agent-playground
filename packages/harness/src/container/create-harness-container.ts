import {
  AccountStorePort,
  ClockPort,
  CredentialPort,
  EDefinitionOrigin,
  EventLogPort,
  IdPort,
  ModelPort,
} from '@dltech/atlas-core'

import { childRunnerSource, type ChildRunnerDepsSource } from '../agents/registry/child-runner'
import { AgentRegistryPort } from '../agents/registry/port'
import { AgentSupervisor } from '../agents/registry/supervisor'
import type { AgentType } from '../agents/types/agent-type'
import { BUILT_IN_AGENT_TYPES } from '../agents/types/built-ins'
import { ClaudeCodeSource, claudeCodePayloadStore } from '../credentials/claude-code-source'
import { fileAccountStore } from '../credentials/account-store'
import { builtinOauthClients } from '../credentials/oauth'
import { atlasVaultFile, atlasVaultKeyFile } from '../credentials/paths'
import { SecretCipher } from '../credentials/secret-cipher'
import { FileSecretsStore } from '../secrets/file-secrets-store'
import { atlasSecretsFile } from '../secrets/paths'
import { RefreshingCredentialPort } from '../credentials/refreshing-credential-port'
import { registerBuiltinHooks } from '../hooks/register-hooks'
import { PrismaTurnLedger, TurnLedgerPort } from '../ledger'
import { resolveHookChain } from '../hooks/resolve-hooks'
import { AiSdkModelPort } from '../model/ai-sdk-model-port'
import { createRawTape } from '../model/raw-tape'
import { registerFileState } from '../files'
import { registerServices } from '../services/register-services'
import { registerShells } from '../shells/register-shells'
import { registerSkills } from '../skills/register-skills'
import { ThreadStorePort, PrismaThreadStore, PrismaEventLog, RandomIds, SystemClock } from '../store'
import { AgentRegistrySourceToken, AgentTypesToken } from '../tools/builtin/agent-tokens'
import { EApprovalRouting, HookedToolDispatcher, ToolDispatcher } from '../tools/dispatch'
import { registerBuiltinTools } from '../tools/register-tools'
import { ToolRegistry } from '../tools/registry'
import { registerDisposable } from './disposal'
import {
  createIsolatedContainer,
  instanceCachingFactory,
  portToken,
  type DependencyContainer,
  type InjectionToken,
} from './injection'
import {
  ClaudeCodeSourceToken,
  HookChainToken,
  KeychainReaderToken,
  LanguageModelToken,
  ModelCardSourceToken,
  PrismaClientToken,
  SecretsStoreToken,
} from './tokens'

export const ChildRunnerDepsToken: InjectionToken<ChildRunnerDepsSource> =
  Symbol('atlas.ChildRunnerDeps')

const embeddedAgentTypes = (): readonly AgentType[] =>
  BUILT_IN_AGENT_TYPES.map((agentType) => ({ ...agentType, origin: EDefinitionOrigin.BuiltIn }))

function registerAgents({ container }: { container: DependencyContainer }): void {
  let live: AgentRegistryPort | undefined

  container.register(AgentTypesToken, { useValue: embeddedAgentTypes() })

  container.register(portToken(AgentRegistryPort), {
    useFactory: instanceCachingFactory((resolver) => {
      live = new AgentSupervisor({
        log: resolver.resolve(portToken(EventLogPort)),
        threads: resolver.resolve(portToken(ThreadStorePort)),
        ids: resolver.resolve(portToken(IdPort)),
        clock: resolver.resolve(portToken(ClockPort)),
        agentTypes: resolver.resolve(AgentTypesToken),
        runners: childRunnerSource({ deps: () => resolver.resolve(ChildRunnerDepsToken)() }),
      })
      return live
    }),
  })

  container.register(AgentRegistrySourceToken, {
    useValue: () => container.resolve(portToken(AgentRegistryPort)),
  })

  registerDisposable({
    container,
    close: async () => {
      await live?.closeAll()
    },
  })
}

export function createHarnessContainer(): DependencyContainer {
  const harness = createIsolatedContainer()

  const tape = createRawTape({ scope: `pid-${process.pid}` })
  registerDisposable({ container: harness, close: () => tape.close() })

  harness.register(portToken(ClockPort), { useClass: SystemClock })
  harness.register(portToken(IdPort), { useClass: RandomIds })
  harness.register(portToken(EventLogPort), {
    useFactory: (resolver) =>
      new PrismaEventLog(
        resolver.resolve(PrismaClientToken),
        resolver.resolve(portToken(ClockPort)),
        resolver.resolve(portToken(IdPort)),
      ),
  })
  harness.register(portToken(TurnLedgerPort), {
    useFactory: (resolver) => new PrismaTurnLedger(resolver.resolve(PrismaClientToken)),
  })
  harness.register(portToken(ThreadStorePort), {
    useFactory: (resolver) =>
      new PrismaThreadStore(
        resolver.resolve(PrismaClientToken),
        resolver.resolve(portToken(ClockPort)),
        resolver.resolve(portToken(IdPort)),
      ),
  })
  harness.register(portToken(AccountStorePort), {
    useFactory: instanceCachingFactory(
      (resolver) =>
        fileAccountStore({
          file: atlasVaultFile(),
          keyFile: atlasVaultKeyFile(),
          clock: resolver.resolve(portToken(ClockPort)),
        }),
    ),
  })

  harness.register(SecretsStoreToken, {
    useFactory: instanceCachingFactory(
      () =>
        new FileSecretsStore({
          file: atlasSecretsFile(),
          cipher: new SecretCipher(atlasVaultKeyFile()),
        }),
    ),
  })

  harness.register(ClaudeCodeSourceToken, {
    useFactory: instanceCachingFactory(
      (resolver) =>
        new ClaudeCodeSource(
          claudeCodePayloadStore({ reader: resolver.resolve(KeychainReaderToken) }),
        ),
    ),
  })

  harness.register(portToken(CredentialPort), {
    useFactory: instanceCachingFactory((resolver) => {
      const clock = resolver.resolve(portToken(ClockPort))

      return new RefreshingCredentialPort({
        accounts: resolver.resolve(portToken(AccountStorePort)),
        clients: builtinOauthClients({ clock }),
        clock,
        sinks: [resolver.resolve(ClaudeCodeSourceToken)],
      })
    }),
  })

  registerFileState({ container: harness })
  registerShells({ container: harness })
  registerServices({ container: harness })
  registerSkills({ container: harness })
  registerAgents({ container: harness })
  registerBuiltinTools({ container: harness })
  registerBuiltinHooks({ container: harness })

  harness.register(HookChainToken, {
    useFactory: instanceCachingFactory((resolver) => resolveHookChain({ container: resolver })),
  })

  harness.register(portToken(ToolDispatcher), {
    useFactory: (resolver) =>
      new HookedToolDispatcher({
        registry: resolver.resolve(portToken(ToolRegistry)),
        hooks: resolver.resolve(HookChainToken),
        approvals: EApprovalRouting.Operator,
      }),
  })

  harness.register(portToken(ModelPort), {
    useFactory: (resolver) => {
      const model = resolver.resolve(LanguageModelToken)
      const card = resolver.isRegistered(ModelCardSourceToken, true)
        ? resolver.resolve(ModelCardSourceToken)
        : undefined
      return new AiSdkModelPort({
        model,
        ...(card === undefined ? {} : { card }),
        hooks: resolver.resolve(HookChainToken),
        tape,
      })
    },
  })

  return harness
}
