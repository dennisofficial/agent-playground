import { describe, expect, it } from 'bun:test'

import { definitionsOfPage, ESettingPage, type RangeDefinition } from '../definition'
import { ESettingsLayer } from '../layers'
import { ATLAS_SETTINGS, ESettingId } from '../registry'
import { rangeValueOf, resolveSettings } from '../resolve'
import { ESettingKind } from '../value'

const definitionOf = (id: ESettingId): RangeDefinition => {
  const found = ATLAS_SETTINGS.find((definition) => definition.id === id)
  if (found === undefined) throw new Error(`${id} is not a registered setting`)
  if (found.kind !== ESettingKind.Range) throw new Error(`${id} is not a range`)
  return found
}

const resolutionOver = (args: { file?: Record<string, unknown>; env?: Record<string, unknown> }) =>
  resolveSettings({
    definitions: ATLAS_SETTINGS,
    layers: [
      { layer: ESettingsLayer.User, origin: 'settings.json', values: args.file ?? {} },
      { layer: ESettingsLayer.Environment, origin: 'environment', values: args.env ?? {} },
    ],
  })

describe('the container resource limits', () => {
  it('ship with defaults a single sandbox can live within', () => {
    expect(definitionOf(ESettingId.ContainerCpus).fallback).toBe(4)
    expect(definitionOf(ESettingId.ContainerMemory).fallback).toBe(8)
  })

  it('answer to the environment, so a launch script can set them without a file', () => {
    expect(definitionOf(ESettingId.ContainerCpus).environmentVariable).toBe('ATLAS_CONTAINER_CPUS')
    expect(definitionOf(ESettingId.ContainerMemory).environmentVariable).toBe(
      'ATLAS_CONTAINER_MEMORY',
    )
    expect(definitionOf(ESettingId.ContainerIdleMinutes).environmentVariable).toBe(
      'ATLAS_CONTAINER_IDLE_MINUTES',
    )
  })

  it('sit beside the execution location on the page the settings overlay walks', () => {
    const general = definitionsOfPage({ definitions: ATLAS_SETTINGS, page: ESettingPage.General })
    const execution = general.filter((definition) => definition.group === 'Execution')

    expect(execution.map((definition) => definition.id)).toContain(ESettingId.ContainerCpus)
    expect(execution.map((definition) => definition.id)).toContain(ESettingId.ContainerMemory)
    expect(execution.map((definition) => definition.id)).toContain(ESettingId.ContainerIdleMinutes)
  })

  it('stops an idle container after half an hour by default', () => {
    expect(definitionOf(ESettingId.ContainerIdleMinutes).fallback).toBe(30)
  })

  it('resolves the idle window out of a settings file', () => {
    const resolution = resolutionOver({ file: { [ESettingId.ContainerIdleMinutes]: 10 } })

    expect(rangeValueOf({ resolution, id: ESettingId.ContainerIdleMinutes, fallback: 30 })).toBe(10)
  })

  it('resolve out of a settings file, so a project can size its own sandboxes', () => {
    const resolution = resolutionOver({
      file: { [ESettingId.ContainerCpus]: 2, [ESettingId.ContainerMemory]: 4 },
    })

    expect(rangeValueOf({ resolution, id: ESettingId.ContainerCpus, fallback: 4 })).toBe(2)
    expect(rangeValueOf({ resolution, id: ESettingId.ContainerMemory, fallback: 8 })).toBe(4)
  })

  it('read numbers from environment strings, the way a shell sets them', () => {
    const resolution = resolutionOver({
      env: { [ESettingId.ContainerCpus]: '6', [ESettingId.ContainerMemory]: '12' },
    })

    expect(rangeValueOf({ resolution, id: ESettingId.ContainerCpus, fallback: 4 })).toBe(6)
    expect(rangeValueOf({ resolution, id: ESettingId.ContainerMemory, fallback: 8 })).toBe(12)
  })

  it('reject a limit outside the range rather than asking the daemon for it', () => {
    const resolution = resolutionOver({ file: { [ESettingId.ContainerMemory]: 0 } })

    expect(rangeValueOf({ resolution, id: ESettingId.ContainerMemory, fallback: 8 })).toBe(8)
    expect(resolution.rejected.map((one) => one.id)).toContain(ESettingId.ContainerMemory)
  })
})
