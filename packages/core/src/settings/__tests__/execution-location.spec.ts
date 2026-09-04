import { describe, expect, it } from 'bun:test'

import { EExecutionLocation } from '../../execution/location'
import { definitionsOfPage, ESettingPage, type ChoiceDefinition } from '../definition'
import { ESettingsLayer } from '../layers'
import { ATLAS_SETTINGS, ESettingId } from '../registry'
import { choiceValueOf, resolveSettings } from '../resolve'
import { ESettingKind } from '../value'

const definitionOf = (id: ESettingId): ChoiceDefinition => {
  const found = ATLAS_SETTINGS.find((definition) => definition.id === id)
  if (found === undefined) throw new Error(`${id} is not a registered setting`)
  if (found.kind !== ESettingKind.Choice) throw new Error(`${id} is not a choice`)
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

describe('the default execution location', () => {
  it('is a choice between the host and a docker container, shipped on the host', () => {
    const definition = definitionOf(ESettingId.ExecutionLocation)

    expect(definition.fallback).toBe(EExecutionLocation.Host)
    expect(definition.options.map((option) => option.value)).toEqual([
      EExecutionLocation.Host,
      EExecutionLocation.Docker,
    ])
  })

  it('answers to the environment, so a launch script can set it without a file', () => {
    expect(definitionOf(ESettingId.ExecutionLocation).environmentVariable).toBe(
      'ATLAS_EXECUTION_LOCATION',
    )
  })

  it('sits on a page the settings overlay walks, beside the other policy knobs', () => {
    expect(
      definitionsOfPage({ definitions: ATLAS_SETTINGS, page: ESettingPage.General }).map(
        (definition) => definition.id,
      ),
    ).toContain(ESettingId.ExecutionLocation)
  })

  it('resolves out of a settings file, so a project can switch its own default', () => {
    const resolution = resolutionOver({ file: { [ESettingId.ExecutionLocation]: 'docker' } })

    expect(
      choiceValueOf({
        resolution,
        id: ESettingId.ExecutionLocation,
        fallback: EExecutionLocation.Host,
      }),
    ).toBe(EExecutionLocation.Docker)
  })

  it('rejects a location Atlas does not know rather than starting in one', () => {
    const resolution = resolutionOver({ file: { [ESettingId.ExecutionLocation]: 'podman' } })

    expect(
      choiceValueOf({
        resolution,
        id: ESettingId.ExecutionLocation,
        fallback: EExecutionLocation.Host,
      }),
    ).toBe(EExecutionLocation.Host)
    expect(resolution.rejected.map((one) => one.id)).toContain(ESettingId.ExecutionLocation)
  })
})
