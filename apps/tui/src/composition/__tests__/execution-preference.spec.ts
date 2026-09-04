import { describe, expect, it } from 'bun:test'

import {
  ATLAS_SETTINGS,
  EExecutionLocation,
  ESettingId,
  ESettingsLayer,
  resolveSettings,
  type SettingsResolution,
} from '@dltech/atlas-core'

import {
  defaultExecutionLocation,
  executionPinned,
  resolveExecutionLocation,
} from '../execution-preference'

const settledOver = (file: Record<string, unknown>): SettingsResolution =>
  resolveSettings({
    definitions: ATLAS_SETTINGS,
    layers: [{ layer: ESettingsLayer.Project, origin: '.atlas/settings.json', values: file }],
  })

const BARE = resolveSettings({ definitions: ATLAS_SETTINGS, layers: [] })

const DOCKER_BY_DEFAULT = settledOver({ [ESettingId.ExecutionLocation]: 'docker' })

describe('where a conversation executes', () => {
  it('lands on the host when nothing has ever said otherwise', () => {
    expect(
      resolveExecutionLocation({ requested: undefined, stored: undefined, settled: BARE }),
    ).toBe(EExecutionLocation.Host)
  })

  it('follows the settings default when the thread carries no location of its own', () => {
    expect(
      resolveExecutionLocation({
        requested: undefined,
        stored: undefined,
        settled: DOCKER_BY_DEFAULT,
      }),
    ).toBe(EExecutionLocation.Docker)
  })

  it('lets the thread outrank the settings default', () => {
    expect(
      resolveExecutionLocation({
        requested: undefined,
        stored: EExecutionLocation.Host,
        settled: DOCKER_BY_DEFAULT,
      }),
    ).toBe(EExecutionLocation.Host)
  })

  it('lets the launch flag outrank the thread', () => {
    expect(
      resolveExecutionLocation({
        requested: 'docker',
        stored: EExecutionLocation.Host,
        settled: BARE,
      }),
    ).toBe(EExecutionLocation.Docker)
  })

  it('reads a flag naming nothing Atlas knows as no flag at all', () => {
    expect(
      resolveExecutionLocation({
        requested: 'podman',
        stored: EExecutionLocation.Docker,
        settled: BARE,
      }),
    ).toBe(EExecutionLocation.Docker)
  })

  it('starts a fresh conversation from the settings default, not from the thread before it', () => {
    expect(
      resolveExecutionLocation({
        requested: undefined,
        stored: undefined,
        settled: DOCKER_BY_DEFAULT,
      }),
    ).toBe(EExecutionLocation.Docker)
  })

  it('falls back whole to the host when the settings file names a location that does not exist', () => {
    const junk = settledOver({ [ESettingId.ExecutionLocation]: 'podman' })

    expect(
      resolveExecutionLocation({ requested: undefined, stored: undefined, settled: junk }),
    ).toBe(EExecutionLocation.Host)
  })
})

describe('the settings default alone', () => {
  it('is the host out of the box', () => {
    expect(defaultExecutionLocation({ settled: BARE })).toBe(EExecutionLocation.Host)
  })

  it('is what the project file switches it to', () => {
    expect(defaultExecutionLocation({ settled: DOCKER_BY_DEFAULT })).toBe(
      EExecutionLocation.Docker,
    )
  })
})

describe('whether a launch is pinned to one location', () => {
  it('is pinned only when the flag names a location Atlas knows', () => {
    expect(executionPinned({ requested: 'docker' })).toBe(true)
    expect(executionPinned({ requested: 'podman' })).toBe(false)
    expect(executionPinned({ requested: undefined })).toBe(false)
  })
})
