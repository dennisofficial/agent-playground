import { describe, expect, it } from 'bun:test'

import { EFooterItemReach } from '../../ui/footer-item'
import { BOTH, controlOf, editorOf, item, key, mounted } from './footer-strip-fixture'

describe('reconciling against the row that survived', () => {
  it('keeps a selection whose pill is still there when a neighbour leaves', async () => {
    const { probe, flush, done } = await mounted(BOTH)

    try {
      controlOf(probe).handleEnter()
      await flush()
      controlOf(probe).handleKey(key({ name: 'right' }))
      await flush()

      probe.setItems?.([item({ id: 'shells' })])
      await flush()

      expect(controlOf(probe).state).toEqual({ itemId: 'shells' })
    } finally {
      await done()
    }
  })

  it('closes the row and refocuses the composer when the held pill is shed', async () => {
    const { probe, flush, done } = await mounted(BOTH)

    try {
      controlOf(probe).handleEnter()
      await flush()
      expect(editorOf(probe).focused).toBe(false)

      probe.setItems?.([item({ id: 'shells' })])
      await flush()

      expect(controlOf(probe).state).toBeNull()
      expect(editorOf(probe).focused).toBe(true)
    } finally {
      await done()
    }
  })

  it('closes the row when the held pill degrades below the arrows', async () => {
    const { probe, flush, done } = await mounted(BOTH)

    try {
      controlOf(probe).handleEnter()
      await flush()

      probe.setItems?.([
        item({ id: 'pr', reach: EFooterItemReach.Pointer }),
        item({ id: 'shells' }),
      ])
      await flush()

      expect(controlOf(probe).state).toBeNull()
      expect(editorOf(probe).focused).toBe(true)
    } finally {
      await done()
    }
  })

  it('leaves a closed row closed when the pills change under it', async () => {
    const { probe, flush, done } = await mounted(BOTH)

    try {
      probe.setItems?.([])
      await flush()

      expect(controlOf(probe).state).toBeNull()
      expect(editorOf(probe).focused).toBe(true)
    } finally {
      await done()
    }
  })
})
