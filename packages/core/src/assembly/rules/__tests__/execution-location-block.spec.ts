import { describe, expect, it } from 'bun:test'

import { EExecutionLocation } from '../../../execution/location'
import { executionLocationNote } from '../execution-location-block'

describe('executionLocationNote', () => {
  it('says nothing on the host', () => {
    expect(
      executionLocationNote({ location: EExecutionLocation.Host, mounts: [] }),
    ).toBeUndefined()
  })

  it('warns that git config --global cannot be fixed from inside a container', () => {
    const note = executionLocationNote({ location: EExecutionLocation.Docker, mounts: [] })

    expect(note).toContain('git config --global')
    expect(note).toContain('read-only')
  })
})
