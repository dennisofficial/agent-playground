import { describe, expect, it } from 'bun:test'

import { atlasHomeFrom, ATLAS_HOME_ENV } from '../atlas-home'

const OPERATOR_HOME = '/Users/dev'

describe('where Atlas keeps its state', () => {
  it('uses one operator home, whether it was launched from source or as the shipped binary', () => {
    expect(atlasHomeFrom({ env: {}, home: OPERATOR_HOME })).toBe('/Users/dev/.atlas')
  })

  it('lets the environment override it, which is what isolates a throwaway run', () => {
    expect(
      atlasHomeFrom({ env: { [ATLAS_HOME_ENV]: '/tmp/scratch-home' }, home: OPERATOR_HOME }),
    ).toBe('/tmp/scratch-home')
  })

  it('ignores an override that is present but empty', () => {
    expect(atlasHomeFrom({ env: { [ATLAS_HOME_ENV]: '' }, home: OPERATOR_HOME })).toBe(
      '/Users/dev/.atlas',
    )
  })

  it('does not double the separator when a directory carries one', () => {
    expect(atlasHomeFrom({ env: {}, home: '/Users/dev/' })).toBe('/Users/dev/.atlas')
    expect(atlasHomeFrom({ env: { [ATLAS_HOME_ENV]: '/tmp/h/' }, home: OPERATOR_HOME })).toBe(
      '/tmp/h',
    )
  })
})
