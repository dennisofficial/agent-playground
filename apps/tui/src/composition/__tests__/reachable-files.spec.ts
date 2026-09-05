import { describe, expect, it } from 'bun:test'

import { EExecutionLocation } from '@dltech/atlas-core'

import { reachableRootsFor } from '../reachable-files'

const PROJECT = '/Users/operator/Developer/project'
const MOUNTS = ['/Users/operator/Developer/shared-lib', '/Users/operator/.atlas/memory']

describe('reachableRootsFor', () => {
  it('leaves the host thread browsing the whole filesystem', () => {
    expect(
      reachableRootsFor({
        location: EExecutionLocation.Host,
        projectDirectory: PROJECT,
        mounts: MOUNTS,
      }),
    ).toBeUndefined()
  })

  it('limits a container thread to the project and the mounts the sandbox actually has', () => {
    expect(
      reachableRootsFor({
        location: EExecutionLocation.Docker,
        projectDirectory: PROJECT,
        mounts: MOUNTS,
      }),
    ).toEqual([PROJECT, ...MOUNTS])
  })
})
