import type { LanguageModel } from 'ai'

import type { ProviderIdentity } from '@dltech/atlas-core'

export const GATEWAY_PROVIDER_ID = 'gateway'

export function providerIdentityOf(model: LanguageModel): ProviderIdentity {
  if (typeof model === 'string') return { id: GATEWAY_PROVIDER_ID, modelId: model }

  return { id: model.provider, modelId: model.modelId }
}
