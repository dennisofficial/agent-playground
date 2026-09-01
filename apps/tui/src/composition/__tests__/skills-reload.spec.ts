import { describe, expect, it } from 'bun:test'

import { reloadedSkills, reloadNotice } from '../skills-reload'
import { fakeSkill } from './fake-app'

const held = (...names: readonly string[]) => names.map((name) => fakeSkill({ name }))

describe('reloadedSkills', () => {
  it('counts what the reload came back with', () => {
    const reloaded = reloadedSkills({ before: held('pirate'), after: held('pirate', 'shanty') })

    expect(reloaded.loaded).toBe(2)
  })

  it('names what was not there before', () => {
    const reloaded = reloadedSkills({ before: held('pirate'), after: held('pirate', 'shanty') })

    expect(reloaded.added).toEqual(['shanty'])
    expect(reloaded.removed).toEqual([])
  })

  it('names what is no longer found', () => {
    const reloaded = reloadedSkills({ before: held('pirate', 'shanty'), after: held('pirate') })

    expect(reloaded.removed).toEqual(['shanty'])
    expect(reloaded.added).toEqual([])
  })

  it('reads a rename as one arrival and one departure', () => {
    const reloaded = reloadedSkills({ before: held('pirate'), after: held('buccaneer') })

    expect(reloaded).toEqual({ loaded: 1, added: ['buccaneer'], removed: ['pirate'] })
  })

  it('holds the names in a stable order, whatever order the sources came back in', () => {
    const reloaded = reloadedSkills({ before: [], after: held('shanty', 'anchor') })

    expect(reloaded.added).toEqual(['anchor', 'shanty'])
  })
})

describe('reloadNotice', () => {
  it('says so plainly when nothing changed', () => {
    expect(reloadNotice({ loaded: 4, added: [], removed: [] })).toBe('4 skills, nothing new')
  })

  it('counts one skill in the singular', () => {
    expect(reloadNotice({ loaded: 1, added: [], removed: [] })).toBe('1 skill, nothing new')
  })

  it('names what arrived', () => {
    expect(reloadNotice({ loaded: 2, added: ['shanty'], removed: [] })).toBe(
      '2 skills — added shanty',
    )
  })

  it('names both sides of a change in one line', () => {
    expect(reloadNotice({ loaded: 2, added: ['shanty'], removed: ['pirate'] })).toBe(
      '2 skills — added shanty, dropped pirate',
    )
  })
})
