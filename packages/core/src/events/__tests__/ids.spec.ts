import { describe, expect, it } from 'bun:test'

import { toThreadId, toCallId, toEventId, toRunId, toSnapshotId } from '../ids'

describe('branded ids', () => {
  it('carries the underlying string through unchanged', () => {
    const values: string[] = [
      toThreadId('thread-1'),
      toRunId('run-1'),
      toEventId('evt-1'),
      toCallId('call-1'),
      toSnapshotId('snap-1'),
    ]

    expect(values).toEqual(['thread-1', 'run-1', 'evt-1', 'call-1', 'snap-1'])
  })

  it('rejects an empty string', () => {
    expect(() => toThreadId('')).toThrow()
    expect(() => toRunId('')).toThrow()
    expect(() => toEventId('')).toThrow()
    expect(() => toCallId('')).toThrow()
    expect(() => toSnapshotId('')).toThrow()
  })
})
