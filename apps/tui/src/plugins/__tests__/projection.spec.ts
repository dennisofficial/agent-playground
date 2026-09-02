import type { Event } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { defineProjection, publishProjections, type ContributedProjection } from '../projection'

const said = (text: string): Event =>
  ({ type: 'user-said', text, at: 0, id: text, threadId: 'thread' }) as unknown as Event

const texts = (events: readonly Event[]): readonly string[] =>
  events.map((event) => (event as unknown as { text: string }).text)

const contributed = (args: {
  pluginId: string
  projection: ContributedProjection['projection']
}): ContributedProjection => args

describe('a projection folds the event log for the plugin that declared it', () => {
  it('starts at the fold of an empty log rather than at undefined', () => {
    const projection = defineProjection({ id: 'plan', fold: ({ events }) => events.length })

    expect(projection.current()).toBe(0)
    expect(projection.version()).toBe(0)
  })

  it('refolds and announces when the log changes', () => {
    let heard = 0
    const projection = defineProjection({ id: 'plan', fold: ({ events }) => texts(events) })
    projection.subscribe(() => {
      heard += 1
    })

    projection.publish({ events: [said('one')] })

    expect(projection.current()).toEqual(['one'])
    expect(projection.version()).toBe(1)
    expect(heard).toBe(1)
  })

  /**
   * `republish` runs on every chunk, and the events array is only reassigned when the log actually
   * grows. Folding on an unchanged reference would rerun every fold on every frame of streaming.
   */
  it('does not refold when the log is the same array it last folded', () => {
    let folds = 0
    const events = [said('one')]
    const projection = defineProjection({
      id: 'plan',
      fold: ({ events: seen }) => {
        folds += 1
        return seen.length
      },
    })

    projection.publish({ events })
    projection.publish({ events })
    projection.publish({ events })

    expect(folds).toBe(2)
    expect(projection.version()).toBe(1)
  })

  it('announces nothing when a new array folds to the value it already held', () => {
    let heard = 0
    const projection = defineProjection({ id: 'count', fold: ({ events }) => events.length })
    projection.subscribe(() => {
      heard += 1
    })

    projection.publish({ events: [said('one')] })
    projection.publish({ events: [said('two')] })

    expect(projection.version()).toBe(1)
    expect(heard).toBe(1)
  })

  it('stops the listener it handed back', () => {
    let heard = 0
    const projection = defineProjection({ id: 'count', fold: ({ events }) => events.length })
    const stop = projection.subscribe(() => {
      heard += 1
    })

    stop()
    projection.publish({ events: [said('one')] })

    expect(heard).toBe(0)
  })
})

describe('one plugin cannot take the transcript down with it', () => {
  it('retires a fold that throws, names it once, and keeps the others folding', () => {
    let good = 0
    const rogue = contributed({
      pluginId: 'rogue',
      projection: defineProjection({
        id: 'rogue',
        fold: ({ events }) => {
          if (events.length > 0) throw new Error('boom')
          return 0
        },
      }),
    })
    const fine = contributed({
      pluginId: 'fine',
      projection: defineProjection({
        id: 'fine',
        fold: ({ events }) => {
          good += 1
          return events.length
        },
      }),
    })

    const first = publishProjections({ projections: [rogue, fine], events: [said('one')] })
    const second = publishProjections({ projections: [rogue, fine], events: [said('two')] })

    expect(first).toEqual(['rogue'])
    expect(second).toEqual([])
    expect(fine.projection.current()).toBe(1)
    expect(good).toBe(3)
  })
})
