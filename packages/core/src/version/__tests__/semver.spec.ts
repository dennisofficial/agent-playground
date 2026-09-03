import { describe, expect, it } from 'bun:test'

import {
  compareSemver,
  formatSemver,
  isNewerSemver,
  parseSemver,
  versionFromTag,
  type Semver,
} from '../semver'

const semver = (text: string): Semver => {
  const parsed = parseSemver(text)
  if (parsed === null) throw new Error(`fixture is not a semver: ${text}`)
  return parsed
}

describe('parseSemver', () => {
  it('reads a plain triple', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null })
  })

  it('reads a prerelease suffix', () => {
    expect(parseSemver('0.2.0-rc.1')?.prerelease).toBe('rc.1')
  })

  it('refuses anything that is not a triple', () => {
    expect(parseSemver('1.2')).toBeNull()
    expect(parseSemver('v1.2.3')).toBeNull()
    expect(parseSemver('1.2.3 ')).toBeNull()
    expect(parseSemver('tui-v0.2.0')).toBeNull()
  })
})

describe('versionFromTag', () => {
  it('reads the version off a component tag', () => {
    expect(versionFromTag({ tag: 'tui-v0.2.0', prefix: 'tui-v' })).toEqual(semver('0.2.0'))
  })

  it('ignores another component’s tag', () => {
    expect(versionFromTag({ tag: 'api-v1.0.0', prefix: 'tui-v' })).toBeNull()
  })
})

describe('formatSemver', () => {
  it('round-trips what parse reads', () => {
    expect(formatSemver(semver('1.2.3'))).toBe('1.2.3')
    expect(formatSemver(semver('0.2.0-rc.1'))).toBe('0.2.0-rc.1')
  })
})

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemver(semver('2.0.0'), semver('10.0.0'))).toBeLessThan(0)
    expect(compareSemver(semver('0.10.0'), semver('0.9.9'))).toBeGreaterThan(0)
    expect(compareSemver(semver('0.2.1'), semver('0.2.0'))).toBeGreaterThan(0)
    expect(compareSemver(semver('1.2.3'), semver('1.2.3'))).toBe(0)
  })

  it('sorts a prerelease before its release', () => {
    expect(isNewerSemver({ candidate: semver('0.2.0'), current: semver('0.2.0-rc.1') })).toBe(true)
    expect(isNewerSemver({ candidate: semver('0.2.0-rc.1'), current: semver('0.2.0') })).toBe(false)
  })
})
