import { describe, expect, it } from 'bun:test'

import { DEFAULT_LAYER_ORIGIN, ESettingsLayer } from '../layers'
import { resolveSettings } from '../resolve'
import { DEMO_SETTINGS } from './fixture'

const resolutionOf = (layers: Parameters<typeof resolveSettings>[0]['layers']) =>
  resolveSettings({ definitions: DEMO_SETTINGS, layers })

describe('resolveSettings', () => {
  it('falls back to the definition and says the value is built in', () => {
    const held = resolutionOf([]).settings.get('demo.toggle')

    expect(held?.value).toBe(true)
    expect(held?.layer).toBe(ESettingsLayer.Default)
    expect(held?.origin).toBe(DEFAULT_LAYER_ORIGIN)
  })

  it('lets a later layer win however the layers arrive', () => {
    const resolution = resolutionOf([
      {
        layer: ESettingsLayer.Environment,
        origin: 'environment',
        values: { 'demo.choice': 'always' },
      },
      { layer: ESettingsLayer.User, origin: '~/.atlas/settings.json', values: { 'demo.choice': 'never' } },
    ])

    const held = resolution.settings.get('demo.choice')
    expect(held?.value).toBe('always')
    expect(held?.layer).toBe(ESettingsLayer.Environment)
  })

  it('carries the origin a value came from so it can be shown', () => {
    const resolution = resolutionOf([
      {
        layer: ESettingsLayer.Project,
        origin: './.atlas/settings.json',
        values: { 'demo.range': 45 },
      },
    ])

    expect(resolution.settings.get('demo.range')?.origin).toBe('./.atlas/settings.json')
  })

  it('takes a per-setting origin over the layer origin', () => {
    const resolution = resolutionOf([
      {
        layer: ESettingsLayer.Environment,
        origin: 'environment',
        values: { 'demo.toggle': 'off' },
        origins: { 'demo.toggle': 'DEMO_TOGGLE' },
      },
    ])

    expect(resolution.settings.get('demo.toggle')?.origin).toBe('DEMO_TOGGLE')
  })

  it('reads the strings an environment variable can only ever be', () => {
    const resolution = resolutionOf([
      {
        layer: ESettingsLayer.Environment,
        origin: 'environment',
        values: { 'demo.toggle': 'off', 'demo.range': '45' },
      },
    ])

    expect(resolution.settings.get('demo.toggle')?.value).toBe(false)
    expect(resolution.settings.get('demo.range')?.value).toBe(45)
  })

  it('reports a value it cannot use instead of dropping it silently', () => {
    const resolution = resolutionOf([
      {
        layer: ESettingsLayer.User,
        origin: '~/.atlas/settings.json',
        values: { 'demo.choice': 'sometimes', 'demo.range': 400 },
      },
    ])

    expect(resolution.rejected).toHaveLength(2)
    expect(resolution.rejected[0]?.reason).toContain('ask, never, always')
    expect(resolution.rejected[1]?.reason).toContain('30 to 50')
    expect(resolution.settings.get('demo.choice')?.value).toBe('ask')
  })

  it('reports a key that is not a setting at all', () => {
    const resolution = resolutionOf([
      { layer: ESettingsLayer.User, origin: '~/.atlas/settings.json', values: { 'demo.gone': 1 } },
    ])

    expect(resolution.rejected[0]?.id).toBe('demo.gone')
    expect(resolution.rejected[0]?.reason).toContain('Atlas knows')
  })
})
