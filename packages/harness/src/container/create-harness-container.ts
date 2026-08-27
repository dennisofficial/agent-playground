import { ClockPort, CredentialPort, EventLogPort, IdPort } from '@dltech/atlas-core'

import { KeychainCredentialPort } from '../credentials/keychain-credential-port'
import { BranchStorePort, PrismaBranchStore, PrismaEventLog, RandomIds, SystemClock } from '../store'
import { createIsolatedContainer, portToken, type DependencyContainer } from './injection'
import { KeychainReaderToken } from './tokens'

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

  return harness
}
