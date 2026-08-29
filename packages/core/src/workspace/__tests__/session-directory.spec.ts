import { describe, expect, it } from 'bun:test'

import type { Event } from '../../events/envelope'
import { hasMovedFromProject, sessionDirectoryOf, workspaceDirectoriesOf } from '../session-directory'

const PROJECT = '/Users/dev/atlas'

let nextSeq = 0

const event = (body: Record<string, unknown>): Event => {
  nextSeq += 1
  return {
    id: `evt_${nextSeq}`,
    seq: nextSeq,
    threadId: 'br_1',
    runId: 'run_1',
    depth: 0,
    at: '2026-08-28T12:00:00.000Z',
    ...body,
  } as Event
}

const said = (text: string) => event({ type: 'user-said', text })
const moved = (path: string) => event({ type: 'cwd-changed', path })

describe('where the session is', () => {
  it('starts at the project directory when nothing has moved it', () => {
    const events = [said('hello'), said('again')]

    expect(sessionDirectoryOf({ events, projectDirectory: PROJECT })).toBe(PROJECT)
  })

  it('follows the last cwd-changed event', () => {
    const events = [said('hello'), moved(`${PROJECT}/packages/core`)]

    expect(sessionDirectoryOf({ events, projectDirectory: PROJECT })).toBe(`${PROJECT}/packages/core`)
  })

  it('takes the most recent move when several have happened', () => {
    const events = [moved(`${PROJECT}/packages/core`), moved(`${PROJECT}/apps/tui`), said('now what')]

    expect(sessionDirectoryOf({ events, projectDirectory: PROJECT })).toBe(`${PROJECT}/apps/tui`)
  })

  it('reverts when the move is rewound out of the log', () => {
    const events = [said('hello'), moved(`${PROJECT}/apps/tui`)]
    const rewound = events.slice(0, 1)

    expect(sessionDirectoryOf({ events: rewound, projectDirectory: PROJECT })).toBe(PROJECT)
  })

  it('follows the model outside the project directory', () => {
    const events = [moved('/Users/dev/Downloads')]

    expect(sessionDirectoryOf({ events, projectDirectory: PROJECT })).toBe('/Users/dev/Downloads')
  })

  it('reports both directories together and whether they differ', () => {
    const settled = workspaceDirectoriesOf({ events: [], projectDirectory: PROJECT })
    const walked = workspaceDirectoriesOf({ events: [moved('/tmp')], projectDirectory: PROJECT })

    expect(settled).toEqual({ projectDirectory: PROJECT, sessionDirectory: PROJECT })
    expect(hasMovedFromProject(settled)).toBe(false)
    expect(walked.sessionDirectory).toBe('/tmp')
    expect(hasMovedFromProject(walked)).toBe(true)
  })
})
