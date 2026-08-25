import { describe, expect, it } from 'bun:test'

import { CORE_PACKAGE_NAME } from '../index'

describe('@dltech/atlas-core', () => {
  it('resolves and imports', () => {
    expect(CORE_PACKAGE_NAME).toBe('@dltech/atlas-core')
  })
})
