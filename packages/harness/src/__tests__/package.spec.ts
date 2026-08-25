import { describe, expect, it } from 'bun:test'

import { CORE_PACKAGE_NAME } from '@dltech/atlas-core'

import { HARNESS_PACKAGE_NAME } from '../index'

describe('@dltech/atlas-harness', () => {
  it('resolves and imports', () => {
    expect(HARNESS_PACKAGE_NAME).toBe('@dltech/atlas-harness')
  })

  it('resolves its workspace dependency on core', () => {
    expect(CORE_PACKAGE_NAME).toBe('@dltech/atlas-core')
  })
})
