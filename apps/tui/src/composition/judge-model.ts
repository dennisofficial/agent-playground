import {
  EEffort,
  EUtilityModelRole,
  findCard,
  refKey,
  resolveUtilityModel,
  type CredentialPort,
  type ModelRef,
} from '@dltech/atlas-core'
import { generatedCatalogue, type ProviderAdapter } from '@dltech/atlas-harness'

import { providerAdapters, unanswerableRef } from './providers'

export const judgeRefFor = ({ override }: { override: string }): ModelRef =>
  resolveUtilityModel({
    role: EUtilityModelRole.Judge,
    override,
    catalogue: generatedCatalogue(),
  })

export function judgeModel({
  ref,
  credentials,
}: {
  ref: ModelRef
  credentials: CredentialPort
}): ReturnType<ProviderAdapter['model']> {
  const adapter = providerAdapters({ credentials }).find((one) => one.id === ref.providerId)
  const card = findCard({ catalog: generatedCatalogue(), ref })
  if (adapter === undefined || card === undefined) throw unanswerableRef(refKey(ref))

  return adapter.model({ card, effort: () => EEffort.Low })
}
