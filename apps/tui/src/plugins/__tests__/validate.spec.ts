import { describe, expect, it } from 'bun:test'

import { EDefinitionOrigin, EHookPhase, EStage } from '@dltech/atlas-core'

import { atlasPluginApi } from '../api'
import {
  EPluginRefusal,
  refuseDuplicateIds,
  validatePluginContribution,
  validateRepoPlugin,
  type LoadedRepoPlugin,
  type RepoPluginOrigin,
} from '../validate'

const { definePlugin } = atlasPluginApi

const wellFormed = definePlugin({ id: 'well-formed', register: () => ({}) })

const loaded = (args: {
  id: string
  definedIn: string
  origin?: RepoPluginOrigin
}): LoadedRepoPlugin => ({
  plugin: definePlugin({ id: args.id, register: () => ({}) }),
  definedIn: args.definedIn,
  origin: args.origin ?? EDefinitionOrigin.User,
})

describe('validateRepoPlugin', () => {
  it('accepts a module whose default export came from definePlugin', () => {
    const validated = validateRepoPlugin({ default: wellFormed })

    expect(validated.ok).toBe(true)
    expect(validated.ok && validated.plugin.id).toBe('well-formed')
  })

  it('refuses a module with no default export and says what a plugin looks like', () => {
    const validated = validateRepoPlugin({ plugin: wellFormed })

    expect(validated.ok).toBe(false)
    expect(validated.ok === false && validated.refusal).toBe(EPluginRefusal.NoDefaultExport)
    expect(validated.ok === false && validated.detail).toContain('definePlugin')
  })

  it('refuses a default export that is not an object', () => {
    const validated = validateRepoPlugin({ default: 'a plugin, honest' })

    expect(validated.ok === false && validated.refusal).toBe(EPluginRefusal.NotAnObject)
  })

  it('names the offending type when the id is not a string', () => {
    const validated = validateRepoPlugin({ default: { id: 7, register: () => ({}) } })

    expect(validated.ok === false && validated.refusal).toBe(EPluginRefusal.IdNotAString)
    expect(validated.ok === false && validated.detail).toContain('number')
  })

  it('refuses an empty id', () => {
    const validated = validateRepoPlugin({ default: { id: '  ', register: () => ({}) } })

    expect(validated.ok === false && validated.refusal).toBe(EPluginRefusal.IdEmpty)
  })

  it('refuses a plugin whose register is not a function, naming the plugin', () => {
    const validated = validateRepoPlugin({ default: { id: 'lopsided', register: {} } })

    expect(validated.ok === false && validated.refusal).toBe(EPluginRefusal.RegisterNotAFunction)
    expect(validated.ok === false && validated.id).toBe('lopsided')
  })

  it('refuses a well-shaped export that did not come from definePlugin', () => {
    const validated = validateRepoPlugin({ default: { id: 'hand-rolled', register: () => ({}) } })

    expect(validated.ok === false && validated.refusal).toBe(EPluginRefusal.NotDefinedByAtlas)
    expect(validated.ok === false && validated.detail).toContain('node_modules')
  })
})

describe('refuseDuplicateIds', () => {
  it('keeps the first claim and names the file that already took the id', () => {
    const read = refuseDuplicateIds([
      loaded({ id: 'twice', definedIn: '/plugins/first.ts' }),
      loaded({ id: 'twice', definedIn: '/plugins/second.ts' }),
      loaded({ id: 'once', definedIn: '/plugins/third.ts' }),
    ])

    expect(read.plugins.map((entry) => entry.definedIn)).toEqual([
      '/plugins/first.ts',
      '/plugins/third.ts',
    ])
    expect(read.refusals).toHaveLength(1)
    expect(read.refusals[0]?.refusal).toBe(EPluginRefusal.DuplicateId)
    expect(read.refusals[0]?.definedIn).toBe('/plugins/second.ts')
    expect(read.refusals[0]?.detail).toContain('/plugins/first.ts')
  })

  it('leaves distinct ids alone', () => {
    const read = refuseDuplicateIds([
      loaded({ id: 'one', definedIn: '/plugins/one.ts' }),
      loaded({ id: 'two', definedIn: '/plugins/two.ts' }),
    ])

    expect(read.refusals).toEqual([])
    expect(read.plugins).toHaveLength(2)
  })
})

describe('validatePluginContribution', () => {
  const hook = {
    phase: EHookPhase.BeforeTool,
    name: 'block-pnpm',
    order: { stage: EStage.Guard, nudge: 10 },
    run: async () => ({}),
  }

  it('accepts a contribution whose hooks are complete', () => {
    const validated = validatePluginContribution({
      contribution: { hooks: [hook] },
      pluginId: 'conventions',
    })

    expect(validated.ok).toBe(true)
  })

  it('accepts a contribution with no hooks at all', () => {
    expect(validatePluginContribution({ contribution: {}, pluginId: 'quiet' }).ok).toBe(true)
  })

  it('refuses a register that returned nothing', () => {
    const validated = validatePluginContribution({ contribution: undefined, pluginId: 'forgetful' })

    expect(validated.ok === false && validated.refusal).toBe(EPluginRefusal.ContributionNotAnObject)
  })

  it('refuses hooks that are not an array', () => {
    const validated = validatePluginContribution({
      contribution: { hooks: hook },
      pluginId: 'singular',
    })

    expect(validated.ok === false && validated.refusal).toBe(EPluginRefusal.HooksNotAnArray)
  })

  it('names the unknown phase and lists the known ones', () => {
    const validated = validatePluginContribution({
      contribution: { hooks: [{ ...hook, phase: 'before-lunch' }] },
      pluginId: 'conventions',
    })

    expect(validated.ok === false && validated.refusal).toBe(EPluginRefusal.HookPhaseUnknown)
    expect(validated.ok === false && validated.detail).toContain('before-lunch')
    expect(validated.ok === false && validated.detail).toContain(EHookPhase.BeforeTool)
  })

  it('refuses a hook with no run', () => {
    const validated = validatePluginContribution({
      contribution: { hooks: [{ ...hook, run: undefined }] },
      pluginId: 'conventions',
    })

    expect(validated.ok === false && validated.refusal).toBe(EPluginRefusal.HookRunMissing)
    expect(validated.ok === false && validated.detail).toContain('conventions:block-pnpm')
  })

  it('refuses a hook with no name', () => {
    const validated = validatePluginContribution({
      contribution: { hooks: [{ ...hook, name: '' }] },
      pluginId: 'conventions',
    })

    expect(validated.ok === false && validated.refusal).toBe(EPluginRefusal.HookNameMissing)
  })

  it('refuses a hook whose order names no known stage', () => {
    const validated = validatePluginContribution({
      contribution: { hooks: [{ ...hook, order: { stage: 'whenever', nudge: 0 } }] },
      pluginId: 'conventions',
    })

    expect(validated.ok === false && validated.refusal).toBe(EPluginRefusal.HookOrderInvalid)
  })
})
