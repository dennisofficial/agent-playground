import { describe, expect, test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import {
  ATLAS_SETTINGS,
  ESettingId,
  ESettingsLayer,
  EWebSearchBackend,
  type ResolvedSetting,
} from '@dltech/atlas-core'
import React from 'react'

import { SettingsDetail } from '../components/settings/detail'

const backendSetting = (value: string): ResolvedSetting => {
  const definition = ATLAS_SETTINGS.find((entry) => entry.id === ESettingId.WebSearchBackend)
  if (definition === undefined) throw new Error('the search backend setting is not registered')
  return { definition, value, layer: ESettingsLayer.Default, origin: 'default' }
}

const frameOf = async (value: string): Promise<string> => {
  const { renderOnce, captureCharFrame } = await testRender(
    <SettingsDetail width={44} setting={backendSetting(value)} cwd="/work" />,
    { width: 44, height: 40 },
  )
  await renderOnce()
  return captureCharFrame()
}

describe('the pane beside the search backend setting', () => {
  test('explains what the chosen backend costs, not only what the setting is', async () => {
    const frame = await frameOf(EWebSearchBackend.DuckDuckGo)

    expect(frame).toContain('DUCKDUCKGO')
    expect(frame).toContain('Nothing to set up')
    expect(frame).toContain('rate limit')
  })

  test('changes with the choice rather than describing them all at once', async () => {
    const tavily = await frameOf(EWebSearchBackend.Tavily)

    expect(tavily).toContain('TAVILY')
    expect(tavily).toContain('Built for agents')
    expect(tavily).not.toContain('Nothing to set up')
  })

  test('sends a keyed backend to the row below rather than to the environment', async () => {
    const frame = await frameOf(EWebSearchBackend.SearXNG)
    const unwrapped = frame.replace(/\s+/g, ' ')

    expect(unwrapped).toContain('Set the row below to its address')
    expect(frame).not.toContain('ATLAS_SEARXNG_URL')
  })
})
