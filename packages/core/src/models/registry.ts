import { DEFAULT_IMAGE_TIER, EImageTier } from '../images/projection'
import { EModelVendor, EThinkingControl, type ModelEntry } from './catalog'

const RELEASE_STAMP = /-\d{8}$/

export const MODEL_CATALOG: readonly ModelEntry[] = [
  {
    id: 'claude-opus-5',
    label: 'opus-5',
    vendor: EModelVendor.Anthropic,
    contextWindow: 1_000_000,
    thinkingControl: EThinkingControl.Effort,
    inputPricePerMillion: 5,
    outputPricePerMillion: 25,
    imageTier: EImageTier.HighResolution,
  },
  {
    id: 'claude-sonnet-5',
    label: 'sonnet-5',
    vendor: EModelVendor.Anthropic,
    contextWindow: 1_000_000,
    thinkingControl: EThinkingControl.Effort,
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
    imageTier: EImageTier.HighResolution,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'haiku-4-5',
    vendor: EModelVendor.Anthropic,
    contextWindow: 200_000,
    thinkingControl: EThinkingControl.Budget,
    inputPricePerMillion: 1,
    outputPricePerMillion: 5,
    imageTier: EImageTier.Standard,
  },
  {
    id: 'gpt-5-codex',
    label: 'gpt-5-codex',
    vendor: EModelVendor.OpenAI,
    contextWindow: 400_000,
    thinkingControl: EThinkingControl.Effort,
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 10,
    imageTier: EImageTier.Standard,
  },
]

/**
 * Anthropic reads at the high-resolution tier from Claude 4.7 on and at the standard tier before it,
 * a per-model fact rather than a version rule. OpenAI bills 32-pixel patches on its own schedule, so
 * the standard tier is only the closest available estimate there.
 * https://platform.claude.com/docs/en/build-with-claude/vision
 */
export const imageTierFor = (modelId: string): EImageTier =>
  modelEntry(modelId)?.imageTier ?? DEFAULT_IMAGE_TIER

export function modelEntry(id: string): ModelEntry | undefined {
  const exact = MODEL_CATALOG.find((entry) => entry.id === id)
  if (exact !== undefined) return exact

  const unstamped = id.replace(RELEASE_STAMP, '')
  return MODEL_CATALOG.find((entry) => entry.id === unstamped)
}
