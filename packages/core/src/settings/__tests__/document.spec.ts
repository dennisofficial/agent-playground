import { describe, expect, it } from 'bun:test'

import {
  EMPTY_SETTINGS_DOCUMENT,
  parseSettingsDocument,
  serialiseSettingsDocument,
  withoutSetting,
  withSetting,
} from '../document'

describe('parseSettingsDocument', () => {
  it('reads a flat map of settings', () => {
    expect(parseSettingsDocument({ 'demo.range': 45 }).values).toEqual({ 'demo.range': 45 })
  })

  it('keeps a key it cannot use so resolution can report it', () => {
    expect(parseSettingsDocument({ 'demo.gone': 'x' }).values).toEqual({ 'demo.gone': 'x' })
  })

  it('lets a hand-written file carry an editor hint', () => {
    const document = parseSettingsDocument({ $schema: './schema.json', 'demo.toggle': false })

    expect(document.values).toEqual({ 'demo.toggle': false })
  })

  it('treats anything that is not an object as no settings at all', () => {
    expect(parseSettingsDocument([1, 2])).toEqual(EMPTY_SETTINGS_DOCUMENT)
    expect(parseSettingsDocument(null)).toEqual(EMPTY_SETTINGS_DOCUMENT)
    expect(parseSettingsDocument('nope')).toEqual(EMPTY_SETTINGS_DOCUMENT)
  })
})

describe('editing a document', () => {
  it('writes a value without touching the one it was given', () => {
    const before = parseSettingsDocument({ 'demo.toggle': true })
    const after = withSetting({ document: before, id: 'demo.range', value: 45 })

    expect(after.values).toEqual({ 'demo.toggle': true, 'demo.range': 45 })
    expect(before.values).toEqual({ 'demo.toggle': true })
  })

  it('drops a value so the layer beneath it is felt again', () => {
    const document = withoutSetting({
      document: parseSettingsDocument({ 'demo.toggle': true, 'demo.range': 45 }),
      id: 'demo.toggle',
    })

    expect(document.values).toEqual({ 'demo.range': 45 })
  })
})

describe('serialiseSettingsDocument', () => {
  it('writes stable, hand-editable json', () => {
    const document = parseSettingsDocument({ 'demo.range': 45, 'demo.toggle': false })

    expect(serialiseSettingsDocument(document)).toBe(
      '{\n  "demo.range": 45,\n  "demo.toggle": false\n}\n',
    )
  })
})
