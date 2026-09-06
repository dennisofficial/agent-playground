import {
  ANTHROPIC_PROVIDER_ID,
  EEffort,
  EUtilityModelRole,
  findCard,
  resolveUtilityModel,
  type CredentialPort,
  type ModelCard,
  type ModelRef,
} from '@dltech/atlas-core'
import {
  AnthropicAdapter,
  cardsForProvider,
  generatedCatalogue,
  INFERENCE_PROVIDER_ID,
  InferenceAdapter,
  OPENAI_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID,
  OpenAiAdapter,
  OpenRouterAdapter,
  type ProviderAdapter,
} from '@dltech/atlas-harness'

type UtilityAdapter = new (args: {
  credentials: CredentialPort
  cards: readonly ModelCard[]
}) => ProviderAdapter

const UTILITY_ADAPTER: Readonly<Record<string, UtilityAdapter>> = {
  [ANTHROPIC_PROVIDER_ID]: AnthropicAdapter,
  [OPENAI_PROVIDER_ID]: OpenAiAdapter,
  [OPENROUTER_PROVIDER_ID]: OpenRouterAdapter,
  [INFERENCE_PROVIDER_ID]: InferenceAdapter,
}

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
  const Adapter = UTILITY_ADAPTER[ref.providerId]
  const card = findCard({ catalog: generatedCatalogue(), ref })
  if (Adapter === undefined || card === undefined)
    throw new Error(`no provider adapter can answer for ${ref.providerId}/${ref.modelId}`)

  return new Adapter({ credentials, cards: cardsForProvider(ref.providerId) }).model({
    card,
    effort: () => EEffort.Low,
  })
}
