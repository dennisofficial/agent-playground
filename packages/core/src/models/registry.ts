import { EModelVendor, type ModelEntry } from './catalog'

const RELEASE_STAMP = /-\d{8}$/

export const MODEL_CATALOG: readonly ModelEntry[] = [
  {
    id: 'claude-opus-5',
    label: 'opus-5',
    vendor: EModelVendor.Anthropic,
    contextWindow: 200_000,
    inputPricePerMillion: 5,
    outputPricePerMillion: 25,
  },
  {
    id: 'claude-sonnet-5',
    label: 'sonnet-5',
    vendor: EModelVendor.Anthropic,
    contextWindow: 200_000,
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'haiku-4-5',
    vendor: EModelVendor.Anthropic,
    contextWindow: 200_000,
    inputPricePerMillion: 1,
    outputPricePerMillion: 5,
  },
  {
    id: 'gpt-5-codex',
    label: 'gpt-5-codex',
    vendor: EModelVendor.OpenAI,
    contextWindow: 400_000,
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 10,
  },
]

export function modelEntry(id: string): ModelEntry | undefined {
  const exact = MODEL_CATALOG.find((entry) => entry.id === id)
  if (exact !== undefined) return exact

  const unstamped = id.replace(RELEASE_STAMP, '')
  return MODEL_CATALOG.find((entry) => entry.id === unstamped)
}
