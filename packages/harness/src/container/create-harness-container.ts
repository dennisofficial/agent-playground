import { ClockPort, CredentialPort, EventLogPort, IdPort, ModelPort } from '@dltech/atlas-core'

import { KeychainCredentialPort } from '../credentials/keychain-credential-port'
import { registerBuiltinHooks } from '../hooks/register-hooks'
import { PrismaTurnLedger, TurnLedgerPort } from '../ledger'
import { resolveHookChain } from '../hooks/resolve-hooks'
import { AiSdkModelPort } from '../model/ai-sdk-model-port'
import { createRawTape } from '../model/raw-tape'
import { registerFileState } from '../files'
import { registerShells } from '../shells/register-shells'
import { ThreadStorePort, PrismaThreadStore, PrismaEventLog, RandomIds, SystemClock } from '../store'
import { HookedToolDispatcher, ToolDispatcher } from '../tools/dispatch'
import { registerBuiltinTools } from '../tools/register-tools'
import { ToolRegistry } from '../tools/registry'
import { registerDisposable } from './disposal'
import {
  createIsolatedContainer,
  instanceCachingFactory,
  portToken,
  type DependencyContainer,
} from './injection'
import { HookChainToken, KeychainReaderToken, LanguageModelToken } from './tokens'

export function createHarnessContainer(): DependencyContainer {
  const harness = createIsolatedContainer()

  const tape = createRawTape({ scope: `pid-${process.pid}` })
  registerDisposable({ container: harness, close: () => tape.close() })

  harness.register(portToken(ClockPort), { useClass: SystemClock })
  harness.register(portToken(IdPort), { useClass: RandomIds })
  harness.register(portToken(EventLogPort), { useClass: PrismaEventLog })
  harness.register(portToken(TurnLedgerPort), { useClass: PrismaTurnLedger })
  harness.register(portToken(ThreadStorePort), { useClass: PrismaThreadStore })
  harness.register(portToken(CredentialPort), {
    useFactory: (resolver) =>
      new KeychainCredentialPort({
        reader: resolver.resolve(KeychainReaderToken),
        clock: resolver.resolve(portToken(ClockPort)),
      }),
  })

  registerFileState({ container: harness })
  registerShells({ container: harness })
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
      }),
  })

  harness.register(portToken(ModelPort), {
    useFactory: (resolver) => {
      const model = resolver.resolve(LanguageModelToken)
      return new AiSdkModelPort({
        model,
        identity: { id: model.provider, modelId: model.modelId },
        hooks: resolver.resolve(HookChainToken),
        tape,
      })
    },
  })

  return harness
}
