import { describe, expect, it } from 'bun:test'

import type { Event } from '../../events/envelope'
import { pullRequestsAfter, pullRequestsOf } from '../pull-requests'

let nextSeq = 0

const event = (body: Record<string, unknown>): Event => {
  nextSeq += 1
  return {
    id: `evt_${nextSeq}`,
    seq: nextSeq,
    threadId: 'br_1',
    runId: 'run_1',
    depth: 0,
    at: '2026-09-04T12:00:00.000Z',
    ...body,
  } as Event
}

const said = (text: string) => event({ type: 'user-said', text })

const linked = (args: { number: number; branch: string; repo?: string }) =>
  event({
    type: 'pull-request-linked',
    number: args.number,
    url: `https://github.com/dltech/atlas/pull/${args.number}`,
    repo: args.repo ?? 'github.com/dltech/atlas',
    branch: args.branch,
  })

describe('the pull requests a session has linked', () => {
  it('is empty until one is linked', () => {
    expect(pullRequestsOf([said('hello'), said('again')])).toEqual([])
  })

  it('lists them oldest first so the latest sits last', () => {
    const events = [
      linked({ number: 401, branch: 'dennis/first' }),
      said('between'),
      linked({ number: 412, branch: 'dennis/second' }),
    ]

    expect(pullRequestsOf(events).map((pr) => pr.number)).toEqual([401, 412])
  })

  it('keeps the first position but refreshes the fields when the same one is linked again', () => {
    const events = [
      linked({ number: 401, branch: 'dennis/first' }),
      linked({ number: 412, branch: 'dennis/second' }),
      linked({ number: 401, branch: 'dennis/first-renamed' }),
    ]

    const folded = pullRequestsOf(events)
    expect(folded.map((pr) => pr.number)).toEqual([401, 412])
    expect(folded[0]?.branch).toBe('dennis/first-renamed')
  })

  it('treats the same number in another repository as a different pull request', () => {
    const events = [
      linked({ number: 401, branch: 'dennis/first' }),
      linked({ number: 401, branch: 'dennis/other', repo: 'github.com/dltech/other' }),
    ]

    expect(pullRequestsOf(events)).toHaveLength(2)
  })
})

describe('folding drafts that have not been written yet', () => {
  it('keeps the linked set when no draft adds one', () => {
    const existing = pullRequestsOf([linked({ number: 401, branch: 'dennis/first' })])

    expect(pullRequestsAfter({ drafts: [{ type: 'user-said', text: 'hi' }], linked: existing })).toBe(
      existing,
    )
  })

  it('appends a draft link after the written ones', () => {
    const existing = pullRequestsOf([linked({ number: 401, branch: 'dennis/first' })])

    const folded = pullRequestsAfter({
      drafts: [
        {
          type: 'pull-request-linked',
          number: 412,
          url: 'https://github.com/dltech/atlas/pull/412',
          repo: 'github.com/dltech/atlas',
          branch: 'dennis/second',
        },
      ],
      linked: existing,
    })

    expect(folded.map((pr) => pr.number)).toEqual([401, 412])
  })
})
