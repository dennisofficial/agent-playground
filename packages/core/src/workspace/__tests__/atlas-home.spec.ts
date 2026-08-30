import { describe, expect, it } from 'bun:test'

import { atlasHomeFrom, ATLAS_HOME_ENV } from '../atlas-home'

const OPERATOR_HOME = '/Users/dev'
const REPO = '/Users/dev/Developer/atlas'

describe('where Atlas keeps its state', () => {
  it('uses the operator home when it is the shipped binary', () => {
    const home = atlasHomeFrom({ env: {}, home: OPERATOR_HOME, sourceRoot: null })

    expect(home).toBe('/Users/dev/.atlas')
  })

  it('stays inside the checkout when it was launched from source', () => {
    const home = atlasHomeFrom({ env: {}, home: OPERATOR_HOME, sourceRoot: REPO })

    expect(home).toBe('/Users/dev/Developer/atlas/.atlas-home')
  })

  it('lets the environment override either one', () => {
    const env = { [ATLAS_HOME_ENV]: '/tmp/scratch-home' }

    expect(atlasHomeFrom({ env, home: OPERATOR_HOME, sourceRoot: null })).toBe('/tmp/scratch-home')
    expect(atlasHomeFrom({ env, home: OPERATOR_HOME, sourceRoot: REPO })).toBe('/tmp/scratch-home')
  })

  it('ignores an override that is present but empty', () => {
    const env = { [ATLAS_HOME_ENV]: '' }

    expect(atlasHomeFrom({ env, home: OPERATOR_HOME, sourceRoot: null })).toBe('/Users/dev/.atlas')
  })

  it('does not double the separator when a directory carries one', () => {
    expect(atlasHomeFrom({ env: {}, home: '/Users/dev/', sourceRoot: null })).toBe(
      '/Users/dev/.atlas',
    )
    expect(atlasHomeFrom({ env: {}, home: OPERATOR_HOME, sourceRoot: `${REPO}/` })).toBe(
      '/Users/dev/Developer/atlas/.atlas-home',
    )
    expect(atlasHomeFrom({ env: { [ATLAS_HOME_ENV]: '/tmp/h/' }, home: OPERATOR_HOME, sourceRoot: null })).toBe(
      '/tmp/h',
    )
  })
})
