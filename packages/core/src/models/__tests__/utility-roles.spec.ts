import { describe, expect, it } from 'bun:test'

import { EImageTier } from '../../images/projection'
import { catalogOf, type ModelCard } from '../card'
import { EUtilityModelRole, UTILITY_MODEL_DEFAULTS, resolveUtilityModel } from '../utility-roles'

const HAIKU: ModelCard = {
  ref: { providerId: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
  label: 'haiku-4.5',
  api: 'anthropic-messages',
  contextWindow: 200_000,
  imageTier: EImageTier.Standard,
}

const GPT_CODEX_MINI: ModelCard = {
  ref: { providerId: 'openai', modelId: 'gpt-5.1-codex-mini' },
  label: 'codex-mini',
  api: 'openai-responses',
  contextWindow: 400_000,
  imageTier: EImageTier.Standard,
}

const CATALOGUE = catalogOf([HAIKU, GPT_CODEX_MINI])

const EVERY_ROLE = [EUtilityModelRole.Tldr, EUtilityModelRole.Titler, EUtilityModelRole.Judge]

describe('resolveUtilityModel', () => {
  it('gives every role the shipped haiku default when no override is set', () => {
    for (const role of EVERY_ROLE) {
      expect(UTILITY_MODEL_DEFAULTS[role]).toEqual({
        providerId: 'anthropic',
        modelId: 'claude-haiku-4-5-20251001',
      })
      expect(resolveUtilityModel({ role, override: '', catalogue: CATALOGUE })).toEqual(HAIKU.ref)
    }
  })

  it('lets one valid override serve every role', () => {
    for (const role of EVERY_ROLE) {
      expect(
        resolveUtilityModel({
          role,
          override: 'openai/gpt-5.1-codex-mini',
          catalogue: CATALOGUE,
        }),
      ).toEqual(GPT_CODEX_MINI.ref)
    }
  })

  it.each([
    ['no separator', 'gpt-5.1-codex-mini'],
    ['no provider', '/gpt-5.1-codex-mini'],
    ['no model', 'openai/'],
  ])('falls back to the role default on a malformed override (%s)', (_shape, override) => {
    expect(
      resolveUtilityModel({ role: EUtilityModelRole.Judge, override, catalogue: CATALOGUE }),
    ).toEqual(HAIKU.ref)
  })

  it('falls back to the role default when the override names a model the catalogue lacks', () => {
    expect(
      resolveUtilityModel({
        role: EUtilityModelRole.Titler,
        override: 'anthropic/claude-opus-4-6',
        catalogue: CATALOGUE,
      }),
    ).toEqual(HAIKU.ref)
  })
})
