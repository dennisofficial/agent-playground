import { ClockPort, CredentialPort, EventLogPort, IdPort, ModelPort } from '@dltech/atlas-core'

import { KeychainCredentialPort } from '../credentials/keychain-credential-port'
import { registerBuiltinHooks } from '../hooks/register-hooks'
import { resolveHookRegistry } from '../hooks/resolve-hooks'
import { createAiSdkModelPort } from '../model/ai-sdk-model-port'
import { BranchStorePort, PrismaBranchStore, PrismaEventLog, RandomIds, SystemClock } from '../store'
import { createDispatch } from '../tools/dispatch'
import { registerBuiltinTools } from '../tools/register-tools'
import { ToolRegistry } from '../tools/registry'
import {
  createIsolatedContainer,
  instanceCachingFactory,
  portToken,
  type DependencyContainer,
} from './injection'
import { DispatchToken, HookRegistryToken, KeychainReaderToken, LanguageModelToken } from './tokens'

export function createHarnessContainer(): DependencyContainer {
  const harness = createIsolatedContainer()

  harness.register(portToken(ClockPort), { useClass: SystemClock })
  harness.register(portToken(IdPort), { useClass: RandomIds })
  harness.register(portToken(EventLogPort), { useClass: PrismaEventLog })
  harness.register(portToken(BranchStorePort), { useClass: PrismaBranchStore })
  harness.register(portToken(CredentialPort), {
    useFactory: (resolver) =>
      new KeychainCredentialPort({
        reader: resolver.resolve(KeychainReaderToken),
        clock: resolver.resolve(portToken(ClockPort)),
      }),
  })

  registerBuiltinTools({ container: harness })
  registerBuiltinHooks({ container: harness })

  harness.register(HookRegistryToken, {
    useFactory: instanceCachingFactory((resolver) => resolveHookRegistry({ container: resolver })),
  })

  harness.register(DispatchToken, {
    useFactory: (resolver) =>
      createDispatch({
        registry: resolver.resolve(portToken(ToolRegistry)),
        hooks: resolver.resolve(HookRegistryToken),
      }),
  })

  harness.register(portToken(ModelPort), {
    useFactory: (resolver) => {
      const model = resolver.resolve(LanguageModelToken)
      return createAiSdkModelPort({
        model,
        identity: { id: model.provider, modelId: model.modelId },
        hooks: resolver.resolve(HookRegistryToken),
      })
    },
  })

  return harness
}
