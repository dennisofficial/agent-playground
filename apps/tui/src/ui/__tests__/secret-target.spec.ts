import { describe, expect, it } from 'bun:test'

import {
  ESettingId,
  ESettingsLayer,
  EWebSearchBackend,
  resolveSettings,
  ATLAS_SETTINGS,
  type SettingsResolution,
} from '@dltech/atlas-core'

import { secretTargetOf } from '../secret-target'

const resolutionOn = (backend?: EWebSearchBackend): SettingsResolution =>
  resolveSettings({
    definitions: ATLAS_SETTINGS,
    layers:
      backend === undefined
        ? []
        : [
            {
              layer: ESettingsLayer.User,
              origin: 'settings.json',
              values: { [ESettingId.WebSearchBackend]: backend },
            },
          ],
  })

describe('secretTargetOf', () => {
  it('points the one key row at whichever backend is chosen', () => {
    expect(
      secretTargetOf({
        id: ESettingId.WebSearchKey,
        resolution: resolutionOn(EWebSearchBackend.Tavily),
      }),
    ).toEqual({
      name: 'search.tavily',
      label: 'Tavily API key',
      masked: true,
      required: true,
      takesOne: true,
    })
  })

  it('follows the backend, so switching one row changes what the other holds', () => {
    const exa = secretTargetOf({
      id: ESettingId.WebSearchKey,
      resolution: resolutionOn(EWebSearchBackend.Exa),
    })
    expect(exa?.name).toBe('search.exa')
  })

  it('asks for an address rather than a key when the backend is your own instance', () => {
    const searxng = secretTargetOf({
      id: ESettingId.WebSearchKey,
      resolution: resolutionOn(EWebSearchBackend.SearXNG),
    })
    expect(searxng?.label).toBe('SearXNG Instance URL')
    expect(searxng?.masked).toBe(false)
  })

  it('says the default backend takes nothing at all', () => {
    const shipped = secretTargetOf({ id: ESettingId.WebSearchKey, resolution: resolutionOn() })
    expect(shipped?.takesOne).toBe(false)
    expect(shipped?.required).toBe(false)
  })

  it('knows Jina answers without the key it accepts', () => {
    const jina = secretTargetOf({
      id: ESettingId.WebSearchKey,
      resolution: resolutionOn(EWebSearchBackend.Jina),
    })
    expect(jina?.takesOne).toBe(true)
    expect(jina?.required).toBe(false)
  })

  it('has nothing to say about a row that is not a secret', () => {
    expect(
      secretTargetOf({ id: ESettingId.WebSearchBackend, resolution: resolutionOn() }),
    ).toBeUndefined()
  })
})
