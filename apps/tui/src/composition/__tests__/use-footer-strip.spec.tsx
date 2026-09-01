import { describe, expect, it } from 'bun:test'

import { EFooterItemReach } from '../../ui/footer-item'
import {
  BOTH,
  controlOf,
  editorOf,
  fired,
  item,
  key,
  mounted,
  typeInto,
} from './footer-strip-fixture'

describe('entering the row', () => {
  it('takes the first pill and blurs the composer behind it', async () => {
    const { probe, flush, done } = await mounted(BOTH)

    try {
      expect(controlOf(probe).handleEnter()).toBe(true)
      await flush()

      expect(controlOf(probe).state).toEqual({ itemId: 'pr' })
      expect(editorOf(probe).focused).toBe(false)
    } finally {
      await done()
    }
  })

  it('declines when there is no pill to enter, so the draft keeps Down', async () => {
    const { probe, flush, done } = await mounted([])

    try {
      expect(controlOf(probe).handleEnter()).toBe(false)
      await flush()
      expect(controlOf(probe).state).toBeNull()
    } finally {
      await done()
    }
  })

  it('declines when nothing on the row answers to the arrows', async () => {
    const { probe, done } = await mounted([item({ id: 'p', reach: EFooterItemReach.Pointer })])

    try {
      expect(controlOf(probe).handleEnter()).toBe(false)
    } finally {
      await done()
    }
  })

  it('declines while the caret still has a row of draft below it', async () => {
    const { probe, done } = await mounted(BOTH)

    try {
      typeInto(probe, 'first line\nsecond line')
      const editor = probe.draft?.editor.current
      if (editor) editor.cursorOffset = 3

      expect(controlOf(probe).handleEnter()).toBe(false)
    } finally {
      await done()
    }
  })

  it('accepts once the caret reaches the last row', async () => {
    const { probe, done } = await mounted(BOTH)

    try {
      typeInto(probe, 'first line\nsecond line')
      expect(controlOf(probe).handleEnter()).toBe(true)
    } finally {
      await done()
    }
  })

  it('declines while the composer is blurred, which is every overlay at once', async () => {
    const { probe, flush, done } = await mounted(BOTH)

    try {
      controlOf(probe).handleEnter()
      await flush()
      expect(editorOf(probe).focused).toBe(false)

      controlOf(probe).handleLeave()
      await flush()
      expect(controlOf(probe).state).toBeNull()
    } finally {
      await done()
    }
  })
})

describe('walking and firing the row', () => {
  it('moves one pill at a time and clamps at both ends', async () => {
    const { probe, flush, done } = await mounted(BOTH)

    try {
      controlOf(probe).handleEnter()
      await flush()

      controlOf(probe).handleKey(key({ name: 'right' }))
      await flush()
      expect(controlOf(probe).state).toEqual({ itemId: 'shells' })

      controlOf(probe).handleKey(key({ name: 'right' }))
      await flush()
      expect(controlOf(probe).state).toEqual({ itemId: 'shells' })

      controlOf(probe).handleKey(key({ name: 'left' }))
      controlOf(probe).handleKey(key({ name: 'left' }))
      await flush()
      expect(controlOf(probe).state).toEqual({ itemId: 'pr' })
    } finally {
      await done()
    }
  })

  it('fires the selected pill on return and leaves the row standing', async () => {
    const { probe, flush, done } = await mounted(BOTH)

    try {
      controlOf(probe).handleEnter()
      await flush()
      controlOf(probe).handleKey(key({ name: 'right' }))
      await flush()

      controlOf(probe).handleKey(key({ name: 'return' }))
      expect(fired).toEqual(['shells'])
      expect(controlOf(probe).state).toEqual({ itemId: 'shells' })
    } finally {
      await done()
    }
  })

  it('hands the composer back on escape, focus and all', async () => {
    const { probe, flush, done } = await mounted(BOTH)

    try {
      controlOf(probe).handleEnter()
      await flush()

      controlOf(probe).handleKey(key({ name: 'escape' }))
      await flush()

      expect(controlOf(probe).state).toBeNull()
      expect(editorOf(probe).focused).toBe(true)
    } finally {
      await done()
    }
  })

  it('types a letter back into the draft rather than eating it', async () => {
    const { probe, flush, done } = await mounted(BOTH)

    try {
      controlOf(probe).handleEnter()
      await flush()

      controlOf(probe).handleKey(key({ name: 'a', sequence: 'a' }))
      await flush()

      expect(controlOf(probe).state).toBeNull()
      expect(editorOf(probe).plainText).toBe('a')
      expect(probe.draft?.value).toBe('a')
      expect(editorOf(probe).focused).toBe(true)
    } finally {
      await done()
    }
  })

  it('keeps typing through once the row has already been left mid-burst', async () => {
    const { probe, flush, done } = await mounted(BOTH)

    try {
      controlOf(probe).handleEnter()
      await flush()

      for (const letter of 'hey')
        controlOf(probe).handleKey(key({ name: letter, sequence: letter }))
      await flush()

      expect(editorOf(probe).plainText).toBe('hey')
      expect(probe.draft?.value).toBe('hey')
    } finally {
      await done()
    }
  })

  it('does not spell DEL into the draft when backspace is pressed in the row', async () => {
    const { probe, flush, done } = await mounted(BOTH)

    try {
      controlOf(probe).handleEnter()
      await flush()

      controlOf(probe).handleKey(key({ name: 'backspace', sequence: '' }))
      await flush()

      expect(editorOf(probe).plainText).toBe('')
      expect(controlOf(probe).state).toEqual({ itemId: 'pr' })
    } finally {
      await done()
    }
  })

  it('fires a clicked pointer-only pill without disturbing where the arrows are', async () => {
    const pointer = item({ id: 'agents', reach: EFooterItemReach.Pointer })
    const { probe, flush, done } = await mounted([...BOTH, pointer])

    try {
      controlOf(probe).handleEnter()
      await flush()

      controlOf(probe).handleActivate(pointer)
      await flush()

      expect(fired).toEqual(['agents'])
      expect(controlOf(probe).state).toEqual({ itemId: 'pr' })
    } finally {
      await done()
    }
  })

  it('skips a pointer-only pill sitting between two the arrows can reach', async () => {
    const between = [
      item({ id: 'pr' }),
      item({ id: 'agents', reach: EFooterItemReach.Pointer }),
      item({ id: 'shells' }),
    ]
    const { probe, flush, done } = await mounted(between)

    try {
      controlOf(probe).handleEnter()
      await flush()

      controlOf(probe).handleKey(key({ name: 'right' }))
      await flush()

      expect(controlOf(probe).state).toEqual({ itemId: 'shells' })
    } finally {
      await done()
    }
  })
})
