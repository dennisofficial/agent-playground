import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EImageDelivery } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { grammarsReady } from '../../ui/markdown/__tests__/harness'
import type { ClipboardImage, ClipboardImageReader } from '../../ui/clipboard-image'
import { open, until, THREAD, REPLY, THINKING } from './app-fixture'
import { fakeApp, scriptedModelPort } from './fake-app'

await grammarsReady()

const WIDTH = 560

const HEIGHT = 280

/** Signature plus IHDR is all `pngSize` reads, and all this fixture has to be. */
const tinyPng = (): Buffer => {
  const header = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(WIDTH, 16)
  header.writeUInt32BE(HEIGHT, 20)
  return header
}

const onTheClipboard = (over: Partial<ClipboardImage> = {}): ClipboardImageReader => {
  const bytes = tinyPng()
  const path = join(mkdtempSync(join(tmpdir(), 'atlas-paste-')), 'shot.png')
  writeFileSync(path, bytes)

  return async () => ({
    path,
    mediaType: 'image/png',
    byteLength: bytes.byteLength,
    width: WIDTH,
    height: HEIGHT,
    delivery: EImageDelivery.Inline,
    tokens: 200,
    ...over,
  })
}

const nothingOnTheClipboard: ClipboardImageReader = async () => null

const scripted = () =>
  fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })

describe('a screenshot pasted into the draft', () => {
  it('writes a numbered tag into the draft where the cursor was', async () => {
    const mounted = await open({ app: scripted(), clipboard: onTheClipboard() })

    try {
      mounted.pressCtrl('v')

      expect(await mounted.frame()).toContain('[Image #1]')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('numbers a second picture apart from the first', async () => {
    const mounted = await open({ app: scripted(), clipboard: onTheClipboard() })

    try {
      mounted.pressCtrl('v')
      await mounted.frame()
      mounted.pressCtrl('v')

      const frame = await mounted.frame()
      expect(frame).toContain('[Image #1]')
      expect(frame).toContain('[Image #2]')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('drops the tag into the sentence being typed rather than above it', async () => {
    const mounted = await open({ app: scripted(), clipboard: onTheClipboard() })

    try {
      await mounted.typeText('look at ')
      mounted.pressCtrl('v')
      await mounted.frame()
      await mounted.typeText('closely')

      expect(await mounted.frame()).toContain('look at [Image #1] closely')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('does nothing at all when the clipboard holds text rather than a picture', async () => {
    const mounted = await open({ app: scripted(), clipboard: nothingOnTheClipboard })

    try {
      mounted.pressCtrl('v')

      const frame = await mounted.frame()
      expect(frame).not.toContain('[Image #')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('rides the message to the model as an image part', async () => {
    const mounted = await open({ app: scripted(), clipboard: onTheClipboard() })

    try {
      mounted.pressCtrl('v')
      await mounted.frame()
      await mounted.typeText('why is this broken')

      mounted.pressEnter()

      const sent = await until({
        holds: async () => {
          await mounted.frame()
          const events = await mounted.app.log.read({ threadId: THREAD })
          return events.some(
            (event) => event.type === 'user-said' && (event.images ?? []).length > 0,
          )
        },
        within: 20_000,
      })

      expect(sent).toBe(true)

      const events = await mounted.app.log.read({ threadId: THREAD })
      const said = events.find((event) => event.type === 'user-said')
      expect(said?.type === 'user-said' ? said.images?.[0] : null).toMatchObject({
        mediaType: 'image/png',
        width: WIDTH,
        height: HEIGHT,
      })
      expect(said?.type === 'user-said' ? said.text : '').toBe('[Image #1] why is this broken')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('names a picture too heavy to inline in the text instead of dropping it', async () => {
    const mounted = await open({
      app: scripted(),
      clipboard: onTheClipboard({ delivery: EImageDelivery.PathOnly }),
    })

    try {
      await mounted.typeText('look at this ')
      mounted.pressCtrl('v')
      await mounted.frame()

      mounted.pressEnter()

      const sent = await until({
        holds: async () => {
          await mounted.frame()
          const events = await mounted.app.log.read({ threadId: THREAD })
          return events.some(
            (event) => event.type === 'user-said' && event.text.includes('shot.png'),
          )
        },
        within: 20_000,
      })

      expect(sent).toBe(true)

      const events = await mounted.app.log.read({ threadId: THREAD })
      const said = events.find((event) => event.type === 'user-said')
      expect(said?.type === 'user-said' ? said.images : null).toBeUndefined()
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('sends nothing but the words when the tag is backspaced away', async () => {
    const mounted = await open({ app: scripted(), clipboard: onTheClipboard() })

    try {
      mounted.pressCtrl('v')
      await mounted.frame()
      for (let press = 0; press < '[Image #1] '.length; press += 1) mounted.pressBackspace()
      await mounted.typeText('never mind')

      mounted.pressEnter()

      const sent = await until({
        holds: async () => {
          await mounted.frame()
          const events = await mounted.app.log.read({ threadId: THREAD })
          return events.some((event) => event.type === 'user-said')
        },
        within: 20_000,
      })

      expect(sent).toBe(true)

      const events = await mounted.app.log.read({ threadId: THREAD })
      const said = events.find((event) => event.type === 'user-said')
      expect(said?.type === 'user-said' ? said.images : null).toBeUndefined()
      expect(said?.type === 'user-said' ? said.text : '').toBe('never mind')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('takes the picture off an empty paste, which is what ⌘V makes of a screenshot', async () => {
    const mounted = await open({ app: scripted(), clipboard: onTheClipboard() })

    try {
      await mounted.paste('')

      expect(await mounted.frame()).toContain('[Image #1]')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('leaves an ordinary text paste alone', async () => {
    const mounted = await open({ app: scripted(), clipboard: onTheClipboard() })

    try {
      await mounted.paste('why is this broken')

      const frame = await mounted.frame()
      expect(frame).toContain('why is this broken')
      expect(frame).not.toContain('[Image #')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('does nothing on an empty paste when the clipboard holds no picture', async () => {
    const mounted = await open({ app: scripted(), clipboard: nothingOnTheClipboard })

    try {
      await mounted.paste('')

      expect(await mounted.frame()).not.toContain('[Image #')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('takes the whole tag on one backspace, never half of it', async () => {
    const mounted = await open({ app: scripted(), clipboard: onTheClipboard() })

    try {
      mounted.pressCtrl('v')
      await mounted.frame()
      mounted.pressBackspace()
      mounted.pressBackspace()

      const frame = await mounted.frame()
      expect(frame).not.toContain('[Image')
      expect(frame).not.toContain('#1')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('leaves the words around a tag alone when the tag goes', async () => {
    const mounted = await open({ app: scripted(), clipboard: onTheClipboard() })

    try {
      await mounted.typeText('look at ')
      mounted.pressCtrl('v')
      await mounted.frame()
      mounted.pressBackspace()
      mounted.pressBackspace()

      expect(await mounted.frame()).toContain('look at')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('still backspaces ordinary text one character at a time', async () => {
    const mounted = await open({ app: scripted(), clipboard: nothingOnTheClipboard })

    try {
      await mounted.typeText('broken')
      mounted.pressBackspace()

      expect(await mounted.frame()).toContain('broke')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('shows what the picture was and cost under the message in the transcript', async () => {
    const mounted = await open({ app: scripted(), clipboard: onTheClipboard() })

    try {
      mounted.pressCtrl('v')
      await mounted.frame()
      await mounted.typeText('why is this broken')
      mounted.pressEnter()

      const shown = await until({
        holds: async () => (await mounted.frame()).includes('shot.png'),
        within: 20_000,
      })

      expect(shown).toBe(true)

      const frame = await mounted.frame()
      expect(frame).toContain('560×280')
      expect(frame).toContain('tokens')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('steps the cursor over a tag whole, so typing lands beside it and not inside', async () => {
    const mounted = await open({ app: scripted(), clipboard: onTheClipboard() })

    try {
      mounted.pressCtrl('v')
      await mounted.frame()

      mounted.pressLeft()
      mounted.pressLeft()
      await mounted.typeText('X')

      expect(await mounted.frame()).toContain('X[Image #1]')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('leaves no token behind when the clipboard has no picture to give', async () => {
    const mounted = await open({ app: scripted(), clipboard: nothingOnTheClipboard })

    try {
      mounted.pressCtrl('v')
      await mounted.frame()
      await new Promise((ready) => setTimeout(ready, 50))

      expect(await mounted.frame()).not.toContain('[Image')
    } finally {
      await mounted.done()
    }
  }, 60_000)
})

describe('a block of pasted text', () => {
  it('folds a long paste into one token, keeping its text for submit', async () => {
    const mounted = await open({ app: scripted(), clipboard: nothingOnTheClipboard })

    try {
      await mounted.paste('one\ntwo\nthree\nfour\nfive\nsix\nseven\nheight')

      expect(await mounted.frame()).toContain('[Pasted text #1')

      mounted.pressEnter()

      const sent = await until({
        holds: async () => {
          await mounted.frame()
          const events = await mounted.app.log.read({ threadId: THREAD })
          return events.some(
            (event) => event.type === 'user-said' && event.text.includes('five'),
          )
        },
        within: 20_000,
      })

      expect(sent).toBe(true)
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('counts a second pasted block apart from the first', async () => {
    const mounted = await open({ app: scripted(), clipboard: nothingOnTheClipboard })

    try {
      await mounted.paste('one\ntwo\nthree\nfour\nfive')
      await mounted.frame()
      await mounted.paste('a\nb\nc\nd\ne')

      const frame = await mounted.frame()
      expect(frame).toContain('[Pasted text #1')
      expect(frame).toContain('[Pasted text #2')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('leaves a short paste spell in the draft as plain text', async () => {
    const mounted = await open({ app: scripted(), clipboard: nothingOnTheClipboard })

    try {
      await mounted.paste('one\ntwo')

      const frame = await mounted.frame()
      expect(frame).toContain('one')
      expect(frame).not.toContain('[Pasted text')
    } finally {
      await mounted.done()
    }
  }, 60_000)
})
