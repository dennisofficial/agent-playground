import { ATLAS_SETTINGS, EMPTY_SETTINGS_DOCUMENT, ESettingId, ESettingsLayer } from '@dltech/atlas-core'
import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { environmentLayer } from '../environment'
import { FileSettingsStore } from '../file-store'
import { MemorySettingsStore } from '../memory-store'
import { createSettingsService } from '../service'

const serviceWith = (args: { user: MemorySettingsStore; project?: MemorySettingsStore; env?: Record<string, string> }) =>
  createSettingsService({
    definitions: ATLAS_SETTINGS,
    user: args.user,
    ...(args.project === undefined ? {} : { project: args.project }),
    ...(args.env === undefined
      ? {}
      : { environment: environmentLayer({ definitions: ATLAS_SETTINGS, env: args.env }) }),
  })

describe('createSettingsService', () => {
  let user: MemorySettingsStore

  beforeEach(() => {
    user = new MemorySettingsStore()
  })

  it('serves the shipped fallbacks when nothing has been set', () => {
    const resolution = serviceWith({ user }).snapshot().resolution

    expect(resolution.settings.get(ESettingId.SidebarWidth)?.value).toBe(42)
    expect(resolution.settings.get(ESettingId.SidebarWidth)?.layer).toBe(ESettingsLayer.Default)
  })

  it('writes a value through and reads it straight back', () => {
    const service = serviceWith({ user })

    expect(service.set({ id: ESettingId.SidebarWidth, value: 50 })).toEqual({ ok: true })
    expect(service.snapshot().resolution.settings.get(ESettingId.SidebarWidth)?.value).toBe(50)
    expect(user.document().values[ESettingId.SidebarWidth]).toBe(50)
  })

  it('tells subscribers a write landed and moves the version on', () => {
    const service = serviceWith({ user })
    let told = 0
    service.subscribe(() => {
      told += 1
    })

    service.set({ id: ESettingId.Accent, value: 'moss' })

    expect(told).toBe(1)
    expect(service.version()).toBe(1)
  })

  it('hands back the same snapshot until something changes', () => {
    const service = serviceWith({ user })
    const first = service.snapshot()

    expect(service.snapshot()).toBe(first)
    service.set({ id: ESettingId.Accent, value: 'plum' })
    expect(service.snapshot()).not.toBe(first)
  })

  it('clearing a value hands the setting back to the layer beneath', () => {
    const service = serviceWith({ user, env: { ATLAS_ACCENT: 'slate' } })
    service.set({ id: ESettingId.Accent, value: 'moss' })

    expect(service.snapshot().resolution.settings.get(ESettingId.Accent)?.value).toBe('slate')

    service.clear({ id: ESettingId.Accent })
    const held = service.snapshot().resolution.settings.get(ESettingId.Accent)
    expect(held?.value).toBe('slate')
    expect(held?.origin).toBe('ATLAS_ACCENT')
  })

  it('a project file outranks the user file', () => {
    const project = new MemorySettingsStore({
      document: { values: { [ESettingId.SidebarWidth]: 60 } },
    })
    const held = serviceWith({
      user: new MemorySettingsStore({ document: { values: { [ESettingId.SidebarWidth]: 34 } } }),
      project,
    }).snapshot().resolution.settings.get(ESettingId.SidebarWidth)

    expect(held?.value).toBe(60)
    expect(held?.layer).toBe(ESettingsLayer.Project)
  })

  it('reports a refused write instead of pretending it saved', () => {
    const service = serviceWith({ user: new MemorySettingsStore({ refuse: 'read-only file system' }) })

    expect(service.set({ id: ESettingId.Accent, value: 'moss' })).toEqual({
      ok: false,
      message: 'read-only file system',
    })
    expect(service.snapshot().resolution.settings.get(ESettingId.Accent)?.value).toBe('clay')
  })

  it('carries a store problem into the snapshot', () => {
    const failing = new MemorySettingsStore({ problem: 'settings.json is not valid json' })

    expect(serviceWith({ user: failing }).snapshot().problems).toEqual([
      'settings.json is not valid json',
    ])
  })
})

describe('FileSettingsStore', () => {
  const fileIn = (name: string): string => join(mkdtempSync(join(tmpdir(), 'atlas-settings-')), name)

  it('reads no settings from a file that is not there', () => {
    const store = new FileSettingsStore({ file: fileIn('settings.json'), label: 'user' })

    expect(store.read()).toEqual({ document: EMPTY_SETTINGS_DOCUMENT })
  })

  it('round-trips through a file it creates itself', () => {
    const file = join(fileIn('unused'), '..', 'nested', 'settings.json')
    const store = new FileSettingsStore({ file, label: 'user' })

    store.write({ values: { [ESettingId.Accent]: 'moss' } })

    expect(store.read().document.values[ESettingId.Accent]).toBe('moss')
    expect(readFileSync(file, 'utf8')).toContain('"appearance.accent": "moss"')
  })

  it('says so when the file is not json rather than losing the settings', () => {
    const file = fileIn('settings.json')
    writeFileSync(file, '{ this is not json', 'utf8')

    const read = new FileSettingsStore({ file, label: '~/.atlas/settings.json' }).read()

    expect(read.document).toEqual(EMPTY_SETTINGS_DOCUMENT)
    expect(read.problem).toContain('~/.atlas/settings.json is not valid json')
  })
})
