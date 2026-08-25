import { describe, expect, it } from 'bun:test'

import { CORE_PACKAGE_NAME } from '@dltech/atlas-core'
import { HARNESS_PACKAGE_NAME } from '@dltech/atlas-harness'

import { APP_PACKAGE_NAME } from '../main'

describe('@dltech/atlas', () => {
  it('resolves and imports', () => {
    expect(APP_PACKAGE_NAME).toBe('@dltech/atlas')
  })

  it('resolves both workspace dependencies', () => {
    expect(CORE_PACKAGE_NAME).toBe('@dltech/atlas-core')
    expect(HARNESS_PACKAGE_NAME).toBe('@dltech/atlas-harness')
  })
})
