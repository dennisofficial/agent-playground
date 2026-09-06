import { describe, expect, it } from 'bun:test'

import { EExecutionLocation } from '@dltech/atlas-core'

import { EFooterItemReach } from '../footer-item'
import { locationPillOf } from '../location-pill'
import { theme } from '../theme'

describe('the execution-location pill', () => {
  it('is absent when the conversation runs on the host', () => {
    expect(locationPillOf({ location: EExecutionLocation.Host })).toBeNull()
  })

  it('is a blue docker chip when the conversation runs in a container', () => {
    const pill = locationPillOf({ location: EExecutionLocation.Docker })

    expect(pill?.spans).toEqual([{ text: 'docker', fg: theme.appBg }])
    expect(pill?.ground).toBe(theme.link)
    expect(pill?.reach).toBe(EFooterItemReach.None)
  })
})
