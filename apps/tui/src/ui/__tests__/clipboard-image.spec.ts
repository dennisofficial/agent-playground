import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'

import {
  appleScriptClipboardBytes,
  attachClipboardImage,
  newPasteMemory,
} from '../clipboard-image'
import { encodePng } from '../images/__tests__/png-fixture'

const platform = process.platform

const pretendPlatform = (name: string): void => {
  Object.defineProperty(process, 'platform', { value: name, configurable: true })
}

afterEach(() => pretendPlatform(platform))

describe('the AppleScript fallback, for a machine the native module skipped', () => {
  it('declines quietly where the coercion does not exist', async () => {
    pretendPlatform('linux')

    expect(await appleScriptClipboardBytes()).toBeNull()
  })

  it('declines quietly on win32 too, rather than shelling out', async () => {
    pretendPlatform('win32')

    expect(await appleScriptClipboardBytes()).toBeNull()
  })
})

const opened: string[] = []

const pasteDirectory = (): string => {
  const made = mkdtempSync(join(tmpdir(), 'atlas-paste-'))
  opened.push(made)
  return made
}

const picture = (shade: number): Buffer =>
  Buffer.from(
    encodePng({
      width: 2,
      height: 2,
      colourType: 2,
      bytesPerPixel: 3,
      samples: new Uint8Array(12).fill(shade),
    }),
  )

afterEach(() => {
  for (const made of opened.splice(0)) rmSync(made, { recursive: true, force: true })
})

describe('attaching the same clipboard picture twice', () => {
  it('writes one file when a single gesture opens both paste doors', async () => {
    const directory = pasteDirectory()
    const memory = newPasteMemory()
    const bytes = picture(7)
    const pull = async (): Promise<Buffer> => bytes

    const first = await attachClipboardImage({ directory, pull, memory })
    const second = await attachClipboardImage({ directory, pull, memory })

    expect(first?.path).toBeDefined()
    expect(second?.path).toBe(first?.path)
    expect(readdirSync(directory)).toHaveLength(1)
  })

  it('writes again once the picture on the clipboard has changed', async () => {
    const directory = pasteDirectory()
    const memory = newPasteMemory()

    const first = await attachClipboardImage({ directory, pull: async () => picture(7), memory })
    const second = await attachClipboardImage({ directory, pull: async () => picture(9), memory })

    expect(first?.path).toBeDefined()
    expect(second?.path).not.toBe(first?.path)
    expect(readdirSync(directory)).toHaveLength(2)
  })

  it('writes a fresh copy when the same picture lands in another thread', async () => {
    const memory = newPasteMemory()
    const bytes = picture(7)
    const pull = async (): Promise<Buffer> => bytes
    const one = pasteDirectory()
    const other = pasteDirectory()

    await attachClipboardImage({ directory: one, pull, memory })
    await attachClipboardImage({ directory: other, pull, memory })

    expect(readdirSync(one)).toHaveLength(1)
    expect(readdirSync(other)).toHaveLength(1)
  })

  it('reports nothing when the clipboard holds no picture', async () => {
    const memory = newPasteMemory()

    const nothing = await attachClipboardImage({
      directory: pasteDirectory(),
      pull: async () => null,
      memory,
    })

    expect(nothing).toBeNull()
  })
})
