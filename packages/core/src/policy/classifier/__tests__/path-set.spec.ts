import { describe, expect, it } from 'bun:test'

import { basenameOf, isUnderPath, normalisePath, parentOf, resolveAgainst } from '../path-set'

describe('normalising a posix path', () => {
  it('collapses a parent segment against the directory before it', () => {
    expect(normalisePath({ path: '/foo/bar/../baz' })).toBe('/foo/baz')
  })

  it('strips trailing separators and repeated ones', () => {
    expect(normalisePath({ path: '/foo//bar/' })).toBe('/foo/bar')
  })

  it('drops a current-directory segment wherever it appears', () => {
    expect(normalisePath({ path: './a/./b' })).toBe('a/b')
  })

  it('keeps a leading parent segment on a relative path it cannot resolve', () => {
    expect(normalisePath({ path: '../../x' })).toBe('../../x')
  })

  it('cannot climb above the root', () => {
    expect(normalisePath({ path: '/../../x' })).toBe('/x')
  })

  it('reads the root as the root', () => {
    expect(normalisePath({ path: '/' })).toBe('/')
  })

  it('reads an empty path as the current directory', () => {
    expect(normalisePath({ path: '' })).toBe('.')
  })
})

describe('deciding whether one path sits under a directory', () => {
  it('is false for a sibling whose name merely starts the same', () => {
    expect(isUnderPath({ directory: '/foo/bar', path: '/foo/bar-baz' })).toBe(false)
  })

  it('is false when a parent segment walks out to that sibling', () => {
    expect(isUnderPath({ directory: '/foo/bar', path: '/foo/bar/../bar-baz' })).toBe(false)
  })

  it('is true for a descendant', () => {
    expect(isUnderPath({ directory: '/foo/bar', path: '/foo/bar/deep/file.ts' })).toBe(true)
  })

  it('counts the directory as under itself', () => {
    expect(isUnderPath({ directory: '/foo/bar', path: '/foo/bar/' })).toBe(true)
  })

  it('puts everything absolute under the root', () => {
    expect(isUnderPath({ directory: '/', path: '/etc/passwd' })).toBe(true)
  })

  it('is false for an ancestor', () => {
    expect(isUnderPath({ directory: '/foo/bar', path: '/foo' })).toBe(false)
  })

  it('keeps a relative escape out of the current directory', () => {
    expect(isUnderPath({ directory: '.', path: '../elsewhere' })).toBe(false)
  })
})

describe('resolving an operand against a base', () => {
  it('joins a relative operand onto the base', () => {
    expect(resolveAgainst({ base: '/a/b', path: 'tmp' })).toBe('/a/b/tmp')
  })

  it('walks out of the base when the operand climbs', () => {
    expect(resolveAgainst({ base: '/a/b', path: '../c/' })).toBe('/a/c')
  })

  it('leaves an absolute operand alone but normalised', () => {
    expect(resolveAgainst({ base: '/a/b', path: '/x/./y' })).toBe('/x/y')
  })

  it('refuses to invent a home directory', () => {
    expect(resolveAgainst({ base: '/a/b', path: '~/notes' })).toBe('~/notes')
  })
})

describe('naming the parts of a path', () => {
  it('gives the parent of a nested path', () => {
    expect(parentOf({ path: '/x/.git' })).toBe('/x')
  })

  it('gives the root as the parent of a top-level entry', () => {
    expect(parentOf({ path: '/x' })).toBe('/')
  })

  it('has no parent for the root', () => {
    expect(parentOf({ path: '/' })).toBeUndefined()
  })

  it('reads the last segment as the basename', () => {
    expect(basenameOf({ path: '/x/.git/' })).toBe('.git')
  })
})
