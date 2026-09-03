import { describe, expect, it } from 'bun:test'

import { restartResumeHandle } from '../restart'

describe('restartResumeHandle', () => {
  it('resumes by the written name when the conversation has one', () => {
    const handle = restartResumeHandle({
      active: { threadId: 'brn_1', title: 'Daily driver setup', started: true },
    })

    expect(handle).toBe('daily-driver-setup')
  })

  it('falls back to the thread id when nothing named the conversation', () => {
    const handle = restartResumeHandle({
      active: { threadId: 'brn_1', title: null, started: true },
    })

    expect(handle).toBe('brn_1')
  })

  it('resumes nothing when no conversation is active', () => {
    expect(restartResumeHandle({ active: null })).toBeNull()
  })

  it('resumes nothing when the conversation never started', () => {
    const handle = restartResumeHandle({
      active: { threadId: 'brn_1', title: null, started: false },
    })

    expect(handle).toBeNull()
  })
})
