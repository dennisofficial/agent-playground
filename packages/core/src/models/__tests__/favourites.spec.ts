import { describe, expect, it } from 'bun:test'

import { formatFavourites, isFavourite, parseFavourites, toggleFavourite } from '../favourites'

describe('what the pinned list reads back as', () => {
  it('has nothing in it before anything was ever pinned', () => {
    expect(parseFavourites(undefined)).toEqual([])
    expect(parseFavourites('')).toEqual([])
  })

  it('names each model once, in the order it was written', () => {
    expect(parseFavourites('anthropic/opus-5,openai/gpt-5')).toEqual([
      'anthropic/opus-5',
      'openai/gpt-5',
    ])
  })

  it('forgives the spacing a hand-edited settings file arrives with', () => {
    expect(parseFavourites(' anthropic/opus-5 , openai/gpt-5 ,,')).toEqual([
      'anthropic/opus-5',
      'openai/gpt-5',
    ])
  })

  it('keeps a model pinned once however many times it was written down', () => {
    expect(parseFavourites('a/b,a/b,c/d')).toEqual(['a/b', 'c/d'])
  })

  it('round-trips through the text a setting holds', () => {
    const pinned = ['anthropic/opus-5', 'openai/gpt-5']
    expect(parseFavourites(formatFavourites(pinned))).toEqual(pinned)
  })
})

describe('pinning and unpinning', () => {
  it('adds a model at the end, so the group holds the order it was built in', () => {
    const once = toggleFavourite({ favourites: ['a/b'], key: 'c/d' })
    expect(once).toEqual(['a/b', 'c/d'])
    expect(toggleFavourite({ favourites: once, key: 'e/f' })).toEqual(['a/b', 'c/d', 'e/f'])
  })

  it('takes a model back out when it is already pinned', () => {
    expect(toggleFavourite({ favourites: ['a/b', 'c/d'], key: 'a/b' })).toEqual(['c/d'])
  })

  it('leaves the list it was given alone', () => {
    const held = ['a/b']
    toggleFavourite({ favourites: held, key: 'c/d' })
    expect(held).toEqual(['a/b'])
  })

  it('says which models are pinned', () => {
    expect(isFavourite({ favourites: ['a/b'], key: 'a/b' })).toBe(true)
    expect(isFavourite({ favourites: ['a/b'], key: 'c/d' })).toBe(false)
  })
})
